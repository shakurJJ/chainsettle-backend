import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { REJECTION_REASON_DESCRIPTIONS } from './dto/reject-proof.dto';

/**
 * Top-level, unauthenticated endpoint that exposes the catalog of proof
 * rejection reason codes.  Clients use this to populate dropdowns before
 * the buyer calls POST .../reject.
 *
 * Route: GET /api/v1/milestones/rejection-reasons
 */
@ApiTags('milestones')
@Controller('milestones')
export class RejectionReasonsController {
  @Get('rejection-reasons')
  @ApiOperation({
    summary: 'List all proof rejection reason codes',
    description:
      'Returns the catalog of structured reason codes that buyers must supply ' +
      'when rejecting a milestone proof. The OTHER code requires an additional note.',
  })
  @ApiResponse({
    status: 200,
    description: 'Rejection reason catalog',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          code: { type: 'string', example: 'INCOMPLETE' },
          description: { type: 'string', example: 'The document is missing required pages, signatures, or sections.' },
        },
      },
      example: [
        { code: 'ILLEGIBLE', description: 'The document is too blurry, dark, or low-resolution to read.' },
        { code: 'WRONG_DOCUMENT', description: 'The file is not the expected document type for this milestone.' },
        { code: 'INCOMPLETE', description: 'The document is missing required pages, signatures, or sections.' },
        { code: 'MISMATCHED_QUANTITY', description: 'The quantities, amounts, or dates in the document do not match the shipment.' },
        { code: 'OTHER', description: 'None of the above. A note is required explaining the specific problem.' },
      ],
    },
  })
  getRejectionReasons() {
    return Object.entries(REJECTION_REASON_DESCRIPTIONS).map(([code, description]) => ({
      code,
      description,
    }));
  }
}
