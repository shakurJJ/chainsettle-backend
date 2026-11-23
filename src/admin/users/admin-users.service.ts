import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../users/user.entity';
import { UserNote } from './user-note.entity';
import { AuditLogService } from '../../audit/audit-log.service';
import { CreateUserNoteDto } from './dto/create-user-note.dto';
import { UpdateUserSupportTagsDto } from './dto/update-user-support-tags.dto';

@Injectable()
export class AdminUsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(UserNote)
    private readonly userNoteRepository: Repository<UserNote>,
    private readonly auditLogService: AuditLogService,
  ) {}

  async findOne(id: string): Promise<User & { notes: UserNote[] }> {
    const user = await this.userRepository.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }
    const notes = await this.userNoteRepository.find({
      where: { userId: id },
      order: { createdAt: 'DESC' },
    });
    return { ...user, notes };
  }

  async listNotes(userId: string): Promise<UserNote[]> {
    await this.ensureUserExists(userId);
    return this.userNoteRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
  }

  async addNote(
    userId: string,
    authorId: string,
    dto: CreateUserNoteDto,
  ): Promise<UserNote> {
    await this.ensureUserExists(userId);
    const note = this.userNoteRepository.create({
      userId,
      authorId,
      body: dto.body,
    });
    const saved = await this.userNoteRepository.save(note);
    await this.auditLogService.record({
      actorId: authorId,
      action: 'user.note.created',
      targetType: 'user',
      targetId: userId,
      metadata: { noteId: saved.id },
    });
    return saved;
  }

  async deleteNote(
    userId: string,
    noteId: string,
    actorId: string,
  ): Promise<void> {
    const note = await this.userNoteRepository.findOne({
      where: { id: noteId, userId },
    });
    if (!note) {
      throw new NotFoundException(`Note ${noteId} not found for user ${userId}`);
    }
    await this.userNoteRepository.remove(note);
    await this.auditLogService.record({
      actorId,
      action: 'user.note.deleted',
      targetType: 'user',
      targetId: userId,
      metadata: { noteId },
    });
  }

  async updateSupportTags(
    userId: string,
    dto: UpdateUserSupportTagsDto,
    actorId: string,
  ): Promise<User> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }
    user.supportTags = dto.supportTags;
    const saved = await this.userRepository.save(user);
    await this.auditLogService.record({
      actorId,
      action: 'user.supportTags.updated',
      targetType: 'user',
      targetId: userId,
      metadata: { supportTags: saved.supportTags },
    });
    return saved;
  }

  private async ensureUserExists(userId: string): Promise<void> {
    const exists = await this.userRepository.exist({ where: { id: userId } });
    if (!exists) {
      throw new NotFoundException(`User ${userId} not found`);
    }
  }
}
