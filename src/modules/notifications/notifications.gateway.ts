import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  WsException,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { NotificationType } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * NotificationsGateway
 *
 * Handles persistent WebSocket connections for real-time notification delivery.
 *
 * Auth flow:
 *   Client connects with: { auth: { token: '<jwt>' } }
 *   On connection, the JWT is verified and the socket joins a room
 *   keyed by userId so notifyUser() can emit to the right subscriber.
 *
 * Rooms: 
 *   - Each authenticated user lives in room `user:<userId>`.
 *   - Users can join shipment rooms `shipment:<shipmentId>` to receive chain events.
 *
 * Events (server → client):
 *   notification  — pushed whenever notifyUser() persists a new record
 *   chainEvent    — pushed whenever a chain event affects a joined shipment
 *
 * Events (client → server):
 *   subscribe           — optional filter to receive only specific NotificationTypes
 *   unsubscribe         — remove a previously set type filter
 *   joinShipmentRoom    — join a shipment room to receive live chain events
 *   leaveShipmentRoom   — leave a shipment room
 */
@Injectable()
@WebSocketGateway({
  namespace: '/notifications',
  cors: {
    origin: '*', // tighten to CORS_ORIGIN in production via gateway options factory
    credentials: true,
  },
  transports: ['websocket', 'polling'],
})
export class NotificationsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(NotificationsGateway.name);

  /** Maps socketId → userId for quick lookups on disconnect. */
  private readonly socketUserMap = new Map<string, string>();

  /** Optional per-socket type filter: socketId → Set<NotificationType> */
  private readonly typeFilters = new Map<string, Set<NotificationType>>();

  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async handleConnection(client: Socket) {
    try {
      const token =
        (client.handshake.auth as Record<string, string>)?.token ||
        (client.handshake.headers as Record<string, string>)?.authorization?.replace('Bearer ', '');

      if (!token) {
        this.reject(client, 'Missing authentication token');
        return;
      }

      const payload = this.jwtService.verify<{ sub: string; stellarAddress: string }>(token, {
        secret: this.config.get<string>('JWT_SECRET'),
      });

      const userId = payload.sub;
      const roomName = this.userRoom(userId);

      await client.join(roomName);
      this.socketUserMap.set(client.id, userId);

      this.logger.log(`[WS] Client ${client.id} authenticated — joined room ${roomName}`);
      client.emit('connected', { message: 'Connected to ChainSettle notifications', userId });
    } catch (err) {
      this.reject(client, 'Invalid or expired token');
    }
  }

  handleDisconnect(client: Socket) {
    const userId = this.socketUserMap.get(client.id);
    this.socketUserMap.delete(client.id);
    this.typeFilters.delete(client.id);
    this.logger.log(`[WS] Client ${client.id} disconnected (userId: ${userId ?? 'unknown'})`);
  }

  // ─── Client → Server Events ───────────────────────────────────────────────

  /**
   * Client sends { types: NotificationType[] } to filter which notification
   * types they want pushed.  Omitting or sending an empty array = all types.
   */
  @SubscribeMessage('subscribe')
  handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { types?: NotificationType[] },
  ) {
    if (!this.socketUserMap.has(client.id)) {
      throw new WsException('Unauthenticated');
    }

    if (body?.types?.length) {
      this.typeFilters.set(client.id, new Set(body.types));
      this.logger.debug(`[WS] ${client.id} subscribed to types: ${body.types.join(', ')}`);
    } else {
      this.typeFilters.delete(client.id); // reset → receive all
    }

    return { event: 'subscribed', data: { types: body?.types ?? [] } };
  }

  /**
   * Remove a type filter — client will receive all notification types again.
   */
  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(@ConnectedSocket() client: Socket) {
    if (!this.socketUserMap.has(client.id)) {
      throw new WsException('Unauthenticated');
    }
    this.typeFilters.delete(client.id);
    return { event: 'unsubscribed', data: {} };
  }

  @SubscribeMessage('joinShipmentRoom')
  async handleJoinShipmentRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { shipmentId: string },
  ) {
    const userId = this.socketUserMap.get(client.id);
    if (!userId) throw new WsException('Unauthenticated');
    if (!body?.shipmentId) throw new WsException('Missing shipmentId');

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new WsException('User not found');

    const shipment = await this.prisma.shipment.findUnique({
      where: { id: body.shipmentId },
      include: { watchers: { where: { userId } } }
    });

    if (!shipment) throw new WsException('Shipment not found');

    // Authorization: Must be participant, watcher, or admin
    const isParticipant = [
      shipment.buyerAddress,
      shipment.supplierAddress,
      shipment.logisticsAddress,
      shipment.arbiterAddress,
    ].includes(user.stellarAddress);

    const isWatcher = shipment.watchers.length > 0;
    const isAdmin = user.role === 'ADMIN';

    if (!isParticipant && !isWatcher && !isAdmin) {
      throw new WsException('Unauthorized to join this shipment room');
    }

    const roomName = `shipment:${body.shipmentId}`;
    await client.join(roomName);
    this.logger.debug(`[WS] Client ${client.id} joined ${roomName}`);
    
    return { event: 'joinedShipmentRoom', data: { shipmentId: body.shipmentId } };
  }

  @SubscribeMessage('leaveShipmentRoom')
  async handleLeaveShipmentRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { shipmentId: string },
  ) {
    if (!this.socketUserMap.has(client.id)) throw new WsException('Unauthenticated');
    if (!body?.shipmentId) return;

    const roomName = `shipment:${body.shipmentId}`;
    await client.leave(roomName);
    this.logger.debug(`[WS] Client ${client.id} left ${roomName}`);
    
    return { event: 'leftShipmentRoom', data: { shipmentId: body.shipmentId } };
  }

  // ─── Server-side push ─────────────────────────────────────────────────────

  /**
   * Emits a notification to every socket in the user's room.
   * Sockets that have an active type filter will only receive
   * the event if the notification's type matches their filter.
   *
   * Called by NotificationsService.notifyUser() after the DB insert.
   */
  pushToUser(userId: string, notification: { id: string; type: NotificationType; [key: string]: any }) {
    const room = this.userRoom(userId);
    const socketsInRoom = this.server.sockets.adapter.rooms.get(room);

    if (!socketsInRoom || socketsInRoom.size === 0) {
      this.logger.debug(`[WS] No active sockets for user ${userId} — skipping push`);
      return;
    }

    // For sockets with type filters, only emit matching types.
    // Sockets without a filter always receive everything.
    socketsInRoom.forEach((socketId) => {
      const filter = this.typeFilters.get(socketId);
      if (!filter || filter.has(notification.type)) {
        this.server.to(socketId).emit('notification', notification);
      }
    });

    this.logger.debug(`[WS] Pushed notification ${notification.id} to room ${room}`);
  }

  /** Emits an arbitrary event to every socket of a user (e.g. `chain:tx` status updates). */
  pushEvent(userId: string, event: string, payload: Record<string, any>) {
    this.server?.to(this.userRoom(userId)).emit(event, payload);
  }

  /**
   * Pushes a live chain event to all sockets subscribed to a specific shipment.
   */
  pushToShipmentRoom(shipmentId: string, eventName: string, payload: any) {
    const room = `shipment:${shipmentId}`;
    this.server.to(room).emit('chainEvent', { shipmentId, eventName, payload });
    this.logger.debug(`[WS] Pushed chainEvent (${eventName}) to room ${room}`);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private userRoom(userId: string): string {
    return `user:${userId}`;
  }

  private reject(client: Socket, reason: string): void {
    this.logger.warn(`[WS] Rejected connection ${client.id}: ${reason}`);
    client.emit('error', { message: reason });
    client.disconnect(true);
  }
}
