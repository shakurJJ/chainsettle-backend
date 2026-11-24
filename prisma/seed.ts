import { createHash } from 'crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const demoUsers = [
    { id: 'demo-buyer', name: 'Demo Buyer', role: 'BUYER' as const },
    { id: 'demo-supplier', name: 'Demo Supplier', role: 'SUPPLIER' as const },
    { id: 'demo-logistics', name: 'Demo Logistics', role: 'LOGISTICS' as const },
    { id: 'demo-arbiter', name: 'Demo Arbiter', role: 'ARBITER' as const },
    { id: 'demo-admin', name: 'Demo Admin', role: 'ADMIN' as const },
];

const addresses = Object.fromEntries(
    demoUsers.map(({ id }) => [
        id,
        Keypair.fromRawEd25519Seed(
            createHash('sha256').update(`chainsettle-demo:${id}`).digest(),
        ).publicKey(),
    ]),
);

const tokenAddress = Keypair.fromRawEd25519Seed(
    createHash('sha256').update('chainsettle-demo:token').digest(),
).publicKey();
const paymentPercents = [30, 40, 30] as const;

const shipments = [
    { id: 'demo-shipment-01', status: 'ACTIVE', isDraft: false, milestones: ['CONFIRMED', 'PROOF_SUBMITTED', 'PENDING'] },
    { id: 'demo-shipment-02', status: 'ACTIVE', isDraft: false, milestones: ['CONFIRMED', 'PENDING', 'PENDING'] },
    { id: 'demo-shipment-03', status: 'ACTIVE', isDraft: false, milestones: ['CONFIRMED', 'CONFIRMED', 'PENDING'] },
    { id: 'demo-shipment-04', status: 'ACTIVE', isDraft: false, milestones: ['PENDING', 'PENDING', 'PENDING'] },
    { id: 'demo-shipment-05', status: 'ACTIVE', isDraft: false, milestones: ['CONFIRMED', 'DISPUTED', 'PENDING'] },
    { id: 'demo-shipment-06', status: 'COMPLETED', isDraft: false, milestones: ['CONFIRMED', 'CONFIRMED', 'CONFIRMED'] },
    { id: 'demo-shipment-07', status: 'CANCELLED', isDraft: false, milestones: ['CONFIRMED', 'PENDING', 'PENDING'] },
    { id: 'demo-shipment-08', status: 'ACTIVE', isDraft: true, milestones: ['PENDING', 'PENDING', 'PENDING'] },
    { id: 'demo-shipment-09', status: 'ACTIVE', isDraft: true, milestones: ['PENDING', 'PENDING', 'PENDING'] },
    { id: 'demo-shipment-10', status: 'ACTIVE', isDraft: true, milestones: ['PENDING', 'PENDING', 'PENDING'] },
] as const;

async function main() {
    for (const user of demoUsers) {
        await prisma.user.upsert({
            where: { id: user.id },
            update: {
                stellarAddress: addresses[user.id],
                name: user.name,
                role: user.role,
            },
            create: {
                id: user.id,
                stellarAddress: addresses[user.id],
                email: `${user.id}@example.test`,
                name: user.name,
                role: user.role,
            },
        });
    }

    for (const [shipmentIndex, shipment] of shipments.entries()) {
        const totalAmount = BigInt((shipmentIndex + 1) * 1_000_000_000);
        const releasedAmount = shipment.milestones.reduce(
            (amount, status, milestoneIndex) =>
                status === 'CONFIRMED'
                    ? amount + (totalAmount * BigInt(paymentPercents[milestoneIndex])) / 100n
                    : amount,
            0n,
        );
        const shipmentData = {
            buyerAddress: addresses['demo-buyer'],
            supplierAddress: addresses['demo-supplier'],
            logisticsAddress: addresses['demo-logistics'],
            arbiterAddress: addresses['demo-arbiter'],
            tokenAddress,
            totalAmount,
            releasedAmount,
            status: shipment.status,
            arbiterStatus: 'ACCEPTED' as const,
            tokenSymbol: 'USDC',
            description: `Demo shipment ${shipmentIndex + 1}: ${[
                'industrial components',
                'medical supplies',
                'packaged food',
            ][shipmentIndex % 3]}`,
            referenceNumber: `DEMO-PO-${String(shipmentIndex + 1).padStart(3, '0')}`,
            tags: ['demo', shipment.status.toLowerCase()],
            expectedDeliveryAt: new Date(Date.now() + (shipmentIndex + 7) * 86_400_000),
            cancelledAt: shipment.status === 'CANCELLED' ? new Date() : null,
            isDraft: shipment.isDraft,
        };

        await prisma.shipment.upsert({
            where: { id: shipment.id },
            update: shipmentData,
            create: { id: shipment.id, ...shipmentData },
        });

        for (const [milestoneIndex, status] of shipment.milestones.entries()) {
            const paymentReleased =
                status === 'CONFIRMED'
                    ? (totalAmount * BigInt(paymentPercents[milestoneIndex])) / 100n
                    : null;
            await prisma.milestone.upsert({
                where: {
                    shipmentId_milestoneIndex: {
                        shipmentId: shipment.id,
                        milestoneIndex,
                    },
                },
                update: {
                    name: ['Goods prepared', 'Shipment in transit', 'Delivery confirmed'][milestoneIndex],
                    paymentPercent: paymentPercents[milestoneIndex],
                    status,
                    disputedAt: status === 'DISPUTED' ? new Date() : null,
                    confirmedAt: status === 'CONFIRMED' ? new Date() : null,
                    paymentReleased,
                },
                create: {
                    shipmentId: shipment.id,
                    milestoneIndex,
                    name: ['Goods prepared', 'Shipment in transit', 'Delivery confirmed'][milestoneIndex],
                    paymentPercent: paymentPercents[milestoneIndex],
                    status,
                    disputedAt: status === 'DISPUTED' ? new Date() : null,
                    confirmedAt: status === 'CONFIRMED' ? new Date() : null,
                    paymentReleased,
                },
            });
        }
    }

    const comments = [
        { id: 'demo-comment-01', shipmentId: 'demo-shipment-01', authorId: 'demo-buyer', body: 'Please share the packing list when it is ready.' },
        { id: 'demo-comment-02', shipmentId: 'demo-shipment-01', authorId: 'demo-supplier', body: 'The packing list has been uploaded with the first milestone.' },
        { id: 'demo-comment-03', shipmentId: 'demo-shipment-05', authorId: 'demo-buyer', body: 'The submitted quantities do not match the purchase order.' },
        { id: 'demo-comment-04', shipmentId: 'demo-shipment-06', authorId: 'demo-supplier', body: 'Delivery completed and signed proof is attached.' },
        { id: 'demo-comment-05', shipmentId: 'demo-shipment-08', authorId: 'demo-buyer', body: 'Draft shipment imported for review.' },
    ];

    for (const comment of comments) {
        await prisma.shipmentComment.upsert({
            where: { id: comment.id },
            update: comment,
            create: comment,
        });
    }

    const notifications = [
        { id: 'demo-notification-01', userId: 'demo-buyer', type: 'SHIPMENT_CREATED', title: 'Shipment created', message: 'Demo shipment 01 is ready to track.', shipmentId: 'demo-shipment-01' },
        { id: 'demo-notification-02', userId: 'demo-supplier', type: 'PROOF_SUBMITTED', title: 'Proof submitted', message: 'A milestone proof was submitted for demo shipment 01.', shipmentId: 'demo-shipment-01' },
        { id: 'demo-notification-03', userId: 'demo-arbiter', type: 'DISPUTE_RAISED', title: 'Dispute raised', message: 'A milestone on demo shipment 05 requires review.', shipmentId: 'demo-shipment-05' },
        { id: 'demo-notification-04', userId: 'demo-buyer', type: 'COMMENT_ADDED', title: 'New shipment comment', message: 'A comment was added to demo shipment 06.', shipmentId: 'demo-shipment-06' },
        { id: 'demo-notification-05', userId: 'demo-admin', type: 'SYSTEM_ALERT', title: 'Demo data loaded', message: 'The local demo dataset is available.', shipmentId: 'demo-shipment-01' },
    ];

    for (const notification of notifications) {
        const { shipmentId, ...data } = notification;
        await prisma.notification.upsert({
            where: { id: notification.id },
            update: { ...data, data: { shipmentId } },
            create: { ...data, data: { shipmentId } },
        });
    }

    console.log(`Seeded ${demoUsers.length} users and ${shipments.length} shipments.`);
}

main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });