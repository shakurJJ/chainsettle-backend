import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { ContactsService } from "./contacts.service";
import {
  CreateContactDto,
  SearchContactsDto,
  UpdateContactDto,
} from "./dto/contact.dto";

@ApiTags("contacts")
@Controller("users/me/contacts")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get("suggestions")
  @ApiOperation({ summary: "Suggest counterparties from past shipments" })
  @ApiResponse({
    status: 200,
    description: "Unsaved shipment counterparties, ranked by shipment count",
  })
  suggestions(
    @CurrentUser("id") ownerId: string,
    @CurrentUser("stellarAddress") address: string,
  ) {
    return this.contacts.suggestions(ownerId, address);
  }

  @Get()
  @ApiOperation({
    summary:
      "List saved contacts; optionally search labels and address prefixes",
  })
  list(@CurrentUser("id") ownerId: string, @Query() query: SearchContactsDto) {
    return this.contacts.list(ownerId, query.q);
  }

  @Post()
  @ApiOperation({ summary: "Save a Stellar address as a contact" })
  @ApiResponse({ status: 201, description: "Contact created" })
  @ApiResponse({ status: 409, description: "Address already saved" })
  create(@CurrentUser("id") ownerId: string, @Body() dto: CreateContactDto) {
    return this.contacts.create(ownerId, dto);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a saved contact" })
  @ApiResponse({ status: 404, description: "Contact not found" })
  @ApiResponse({ status: 409, description: "Address already saved" })
  update(
    @CurrentUser("id") ownerId: string,
    @Param("id") id: string,
    @Body() dto: UpdateContactDto,
  ) {
    return this.contacts.update(ownerId, id, dto);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Delete a saved contact" })
  @ApiResponse({ status: 204, description: "Contact deleted" })
  @ApiResponse({ status: 404, description: "Contact not found" })
  remove(@CurrentUser("id") ownerId: string, @Param("id") id: string) {
    return this.contacts.remove(ownerId, id);
  }
}
