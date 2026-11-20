export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  database: {
    url: process.env.DATABASE_URL,
  },
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  },
  account: {
    // Grace period (in days) during which a deactivated account can be
    // restored before its PII is anonymised. Defaults to 30 days.
    deactivationGracePeriodDays: parseInt(
      process.env.ACCOUNT_DEACTIVATION_GRACE_PERIOD_DAYS ?? '30',
      10,
    ),
  },
});
