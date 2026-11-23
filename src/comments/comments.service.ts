import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Comment } from './entities/comment.entity';
import { CreateCommentDto } from './dto/create-comment.dto';
import { IpfsService } from '../ipfs/ipfs.service';
import { Shipment } from '../shipments/entities/shipment.entity';

const MAX_ATTACHMENTS_PER_COMMENT = 3;

export interface CommentAttachment {
  cid: string;
  mimeType: string;
  size: number;
  name?: string;
}

@Injectable()
export class CommentsService {
  constructor(
    @InjectRepository(Comment)
    private readonly commentRepository: Repository<Comment>,
    @InjectRepository(Shipment)
    private readonly shipmentRepository: Repository<Shipment>,
    private readonly ipfsService: IpfsService,
  ) {}

  async create(
    shipmentId: string,
    userId: string,
    dto: CreateCommentDto,
  ): Promise<Comment> {
    const shipment = await this.shipmentRepository.findOne({
      where: { id: shipmentId },
    });
    if (!shipment) {
      throw new NotFoundException('Shipment not found');
    }

    const files = dto.files ?? [];
    if (files.length > MAX_ATTACHMENTS_PER_COMMENT) {
      throw new BadRequestException(
        `A comment may have at most ${MAX_ATTACHMENTS_PER_COMMENT} attachments`,
      );
    }

    const attachments: CommentAttachment[] = [];
    for (const file of files) {
      const uploaded = await this.ipfsService.upload(file.buffer, file.mimetype);
      attachments.push({
        cid: uploaded.cid,
        mimeType: file.mimetype,
        size: file.size,
        name: file.originalname,
      });
    }

    const comment = this.commentRepository.create({
      shipmentId,
      userId,
      body: dto.body,
      attachments,
    });
    return this.commentRepository.save(comment);
  }

  async findByShipment(shipmentId: string, userId: string): Promise<Comment[]> {
    await this.assertParticipant(shipmentId, userId);
    return this.commentRepository.find({
      where: { shipmentId },
      order: { createdAt: 'ASC' },
    });
  }

  async getAttachment(
    shipmentId: string,
    commentId: string,
    cid: string,
    userId: string,
  ): Promise<Buffer> {
    await this.assertParticipant(shipmentId, userId);
    const comment = await this.commentRepository.findOne({
      where: { id: commentId, shipmentId },
    });
    if (!comment) {
      throw new NotFoundException('Comment not found');
    }
    const attachment = (comment.attachments ?? []).find((a) => a.cid === cid);
    if (!attachment) {
      throw new NotFoundException('Attachment not found');
    }
    return this.ipfsService.fetch(cid);
  }

  private async assertParticipant(
    shipmentId: string,
    userId: string,
  ): Promise<void> {
    const shipment = await this.shipmentRepository.findOne({
      where: { id: shipmentId },
    });
    if (!shipment) {
      throw new NotFoundException('Shipment not found');
    }
    const participants = shipment.participants ?? [];
    const isParticipant =
      shipment.ownerId === userId ||
      participants.some((p) => p.userId === userId);
    if (!isParticipant) {
      throw new ForbiddenException('Not a participant of this shipment');
    }
  }
}
