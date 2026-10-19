import { envValidationSchema } from './env.validation';

describe('envValidationSchema', () => {
  const validBaseEnv = {
    JWT_SECRET: 'super-secret-key-for-jwt-testing',
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/chainsettle',
    STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
    STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
    CHAINSETTTLE_CONTRACT_ID: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    USDC_TOKEN_ADDRESS: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    STELLAR_SECRET_KEY: 'SBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    SMTP_HOST: 'smtp.example.com',
    SMTP_USER: 'test@example.com',
    SMTP_PASS: 'password',
    EMAIL_FROM: 'noreply@chainsettle.com',
    REDIS_URL: 'redis://localhost:6379',
  };

  it('should supply default values for milestone reminder and dispute escalation variables', () => {
    const { error, value } = envValidationSchema.validate(validBaseEnv);
    expect(error).toBeUndefined();
    expect(value.OVERDUE_REMINDER_1_DAYS).toBe(0);
    expect(value.OVERDUE_REMINDER_3_DAYS).toBe(3);
    expect(value.DISPUTE_ESCALATION_DAYS).toBe(7);
  });

  it('should accept valid numeric values for reminder and escalation variables', () => {
    const { error, value } = envValidationSchema.validate({
      ...validBaseEnv,
      OVERDUE_REMINDER_1_DAYS: 2,
      OVERDUE_REMINDER_3_DAYS: 5,
      DISPUTE_ESCALATION_DAYS: 14,
    });
    expect(error).toBeUndefined();
    expect(value.OVERDUE_REMINDER_1_DAYS).toBe(2);
    expect(value.OVERDUE_REMINDER_3_DAYS).toBe(5);
    expect(value.DISPUTE_ESCALATION_DAYS).toBe(14);
  });

  it('should parse string representations of integers correctly', () => {
    const { error, value } = envValidationSchema.validate({
      ...validBaseEnv,
      OVERDUE_REMINDER_1_DAYS: '1',
      OVERDUE_REMINDER_3_DAYS: '4',
      DISPUTE_ESCALATION_DAYS: '10',
    });
    expect(error).toBeUndefined();
    expect(value.OVERDUE_REMINDER_1_DAYS).toBe(1);
    expect(value.OVERDUE_REMINDER_3_DAYS).toBe(4);
    expect(value.DISPUTE_ESCALATION_DAYS).toBe(10);
  });

  it('should fail with clear Joi error when DISPUTE_ESCALATION_DAYS is not a number (e.g. "seven")', () => {
    const { error } = envValidationSchema.validate({
      ...validBaseEnv,
      DISPUTE_ESCALATION_DAYS: 'seven',
    });
    expect(error).toBeDefined();
    expect(error?.message).toContain('"DISPUTE_ESCALATION_DAYS" must be a number');
  });

  it('should fail when OVERDUE_REMINDER_1_DAYS is negative', () => {
    const { error } = envValidationSchema.validate({
      ...validBaseEnv,
      OVERDUE_REMINDER_1_DAYS: -1,
    });
    expect(error).toBeDefined();
    expect(error?.message).toContain('"OVERDUE_REMINDER_1_DAYS" must be greater than or equal to 0');
  });

  it('should fail when OVERDUE_REMINDER_3_DAYS is less than 1', () => {
    const { error } = envValidationSchema.validate({
      ...validBaseEnv,
      OVERDUE_REMINDER_3_DAYS: 0,
    });
    expect(error).toBeDefined();
    expect(error?.message).toContain('"OVERDUE_REMINDER_3_DAYS" must be greater than or equal to 1');
  });

  it('should fail when DISPUTE_ESCALATION_DAYS is less than 1', () => {
    const { error } = envValidationSchema.validate({
      ...validBaseEnv,
      DISPUTE_ESCALATION_DAYS: 0,
    });
    expect(error).toBeDefined();
    expect(error?.message).toContain('"DISPUTE_ESCALATION_DAYS" must be greater than or equal to 1');
  });
});
