import { NotificationType } from '@prisma/client';
import { WebhooksController } from './webhooks.controller';

describe('WebhooksController', () => {
  let controller: WebhooksController;

  beforeEach(() => {
    controller = new WebhooksController({} as any, { get: jest.fn() } as any);
  });

  describe('GET /webhooks/event-types', () => {
    it('lists every NotificationType value (#537)', () => {
      expect(controller.getEventTypes()).toEqual(
        Object.values(NotificationType),
      );
    });

    it('includes SHIPMENT_COMMENT_CREATED so integrations can subscribe (#537)', () => {
      expect(controller.getEventTypes()).toContain(
        NotificationType.SHIPMENT_COMMENT_CREATED,
      );
    });
  });
});
