/**
 * Jest globalTeardown — currently a no-op because each spec file
 * is responsible for closing its own NestJS application in afterAll().
 * Reserved for future broker cleanup tasks.
 */
export default async function globalTeardown() {
  // intentionally empty
}
