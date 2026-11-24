# WebSocket Gateway

ChainSettle uses **Socket.IO** to push live events to connected clients. This allows the frontend to show real-time notifications and instantly update shipment state when a contract event is detected on-chain, without polling.

## Connection Details

- **Namespace:** `/notifications`
- **URL Example (Local):** `ws://localhost:3000/notifications`
- **Transports:** `websocket`, `polling` (fallback)

### Authentication

Clients must authenticate by providing a valid JWT during the handshake. This can be passed either in the `auth` object or via the standard `Authorization` header.

```javascript
// Method 1: Using the `auth` object (Recommended for Socket.IO)
const socket = io('ws://localhost:3000/notifications', {
  auth: {
    token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
  }
});

// Method 2: Using the Authorization header
const socket = io('ws://localhost:3000/notifications', {
  extraHeaders: {
    Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
  }
});
```

If the token is missing or invalid, the server will emit an `error` event and forcefully disconnect the socket.

## Managing Subscriptions

By default, an authenticated socket joins their personal room (`user:<userId>`) and will receive all `notification` events pushed to them.

### Optional: Filtering Notifications
If you only care about specific notification types, you can emit a `subscribe` event with a list of types. This overrides the default "all" behavior.

```javascript
socket.emit('subscribe', { types: ['SHIPMENT_CREATED', 'PAYMENT_RELEASED'] });
```
To receive everything again:
```javascript
socket.emit('unsubscribe');
```

## Shipment Rooms (Live Chain Events)

You can subscribe to live on-chain events for a specific shipment by joining its shipment room.

### Joining a Shipment Room
```javascript
socket.emit('joinShipmentRoom', { shipmentId: 'SHIP-123' });
```

### Leaving a Shipment Room
```javascript
socket.emit('leaveShipmentRoom', { shipmentId: 'SHIP-123' });
```

### Authorization Rules
To join a shipment room, the user must be authenticated and meet at least one of the following criteria:
1. They are a direct **participant** (Buyer, Supplier, Logistics, or Arbiter) in the shipment.
2. They are an active **watcher** (they have "favorited" or subscribed to the shipment).
3. They are an **Admin** user.

If a user does not meet these criteria, the gateway will throw a `WsException` ("Unauthorized to join this shipment room") and they will not be added to the room.

## Emitted Events & Payloads (Server → Client)

Below is a table of every event emitted by the gateway and its payload shape:

| Event Name | Sample Payload | Description |
|---|---|---|
| `connected` | `{ "message": "Connected to ChainSettle notifications", "userId": "user-uuid" }` | Emitted immediately after successful auth. |
| `error` | `{ "message": "Invalid or expired token" }` | Emitted if authentication fails, followed by a disconnect. |
| `subscribed` | `{ "types": ["SHIPMENT_CREATED"] }` | Acknowledges a `subscribe` request. |
| `unsubscribed` | `{}` | Acknowledges an `unsubscribe` request. |
| `joinedShipmentRoom` | `{ "shipmentId": "SHIP-123" }` | Acknowledges successfully joining a shipment room. |
| `leftShipmentRoom` | `{ "shipmentId": "SHIP-123" }` | Acknowledges successfully leaving a shipment room. |
| `notification` | `{ "id": "uuid", "type": "PAYMENT_RELEASED", "title": "...", "message": "...", "data": { ... } }` | A standard in-app notification routed to the user. |
| `chainEvent` | `{ "shipmentId": "SHIP-123", "eventName": "milestone_confirmed", "payload": ["SHIP-123", 0, 10000000] }` | A raw on-chain event propagated in real-time to the shipment room. |

## Reconnection & Token Expiration

- **Reconnections:** Socket.IO handles reconnections automatically. When the client reconnects, the handshake re-runs. 
- **Token Expiration:** If the JWT expires while disconnected, the reconnection handshake will fail. The server will emit an `error` event and drop the connection. The frontend should catch this, refresh the token via the normal login flow, and instantiate a new Socket instance with the fresh token.

## Minimal Client Snippet

You can run this snippet locally against the dev server. Make sure to swap out `'YOUR_JWT_HERE'` with a real token.

```html
<!DOCTYPE html>
<html>
<head>
  <title>ChainSettle WebSocket Test</title>
  <script src="https://cdn.socket.io/4.7.2/socket.io.min.js"></script>
</head>
<body>
  <h1>WS Test (Check Console)</h1>
  <script>
    const token = 'YOUR_JWT_HERE'; // Replace this!
    const shipmentId = 'SHIP-123'; // Replace with a shipment you are authorized for!

    const socket = io('ws://localhost:3000/notifications', {
      auth: { token }
    });

    socket.on('connect', () => console.log('[Socket] Connected!', socket.id));
    socket.on('disconnect', (reason) => console.log('[Socket] Disconnected:', reason));
    socket.on('error', (err) => console.error('[Socket Error]', err));

    // Gateway-specific events
    socket.on('connected', (data) => {
      console.log('Auth Success:', data);
      
      // Attempt to join a shipment room
      socket.emit('joinShipmentRoom', { shipmentId });
    });

    socket.on('joinedShipmentRoom', (data) => console.log('Joined Room:', data));
    
    // Listen for in-app notifications
    socket.on('notification', (notif) => {
      console.log('Received Notification:', notif);
    });

    // Listen for live chain events
    socket.on('chainEvent', (event) => {
      console.log('Received Chain Event:', event);
    });
  </script>
</body>
</html>
```
