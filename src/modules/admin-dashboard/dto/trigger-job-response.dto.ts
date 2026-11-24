import { ApiProperty } from "@nestjs/swagger";

export class TriggerJobResponseDto {
  @ApiProperty({
    example: "reconciliation",
    description: "Name of the job that was triggered",
  })
  job: string;

  @ApiProperty({
    example: "accepted",
    description: "The run has been queued and is executing in the background",
  })
  status: "accepted";

  @ApiProperty({
    example: "2026-10-20T09:15:00.000Z",
    description: "Timestamp when the manual run was triggered",
  })
  triggeredAt: string;
}
