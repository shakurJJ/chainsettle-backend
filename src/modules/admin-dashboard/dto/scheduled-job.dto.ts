import { ApiProperty } from "@nestjs/swagger";

export class ScheduledJobDto {
  @ApiProperty({
    example: "notification-cleanup",
    description: "Name of the scheduled cron job",
  })
  name: string;

  @ApiProperty({
    example: "0 2 * * *",
    description: "Cron schedule expression",
  })
  schedule: string;

  @ApiProperty({
    example: "2026-10-19T02:00:00.000Z",
    nullable: true,
    description: "Timestamp when the job was last executed",
  })
  lastRunAt: string | null;

  @ApiProperty({
    example: "SUCCESS",
    enum: ["SUCCESS", "FAILURE", null],
    nullable: true,
    description: "Status result of the last job execution",
  })
  lastResult: "SUCCESS" | "FAILURE" | null;

  @ApiProperty({
    example: 142,
    nullable: true,
    description: "Duration of the last execution in milliseconds",
  })
  durationMs: number | null;

  @ApiProperty({
    example: "2026-10-20T02:00:00.000Z",
    nullable: true,
    description: "Timestamp of the next scheduled execution",
  })
  nextRunAt: string | null;
}
