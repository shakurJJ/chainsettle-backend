import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../../auth/guards/admin.guard';
import { AdminUsersService } from './admin-users.service';
import { CreateUserNoteDto } from './dto/create-user-note.dto';

@Controller('admin/users')
@UseGuards(AdminGuard)
export class AdminUsersController {
  constructor(private readonly adminUsersService: AdminUsersService) {}

  @Get(':id')
  async getUser(@Param('id') id: string) {
    return this.adminUsersService.getUserWithSupportContext(id);
  }

  @Get(':id/notes')
  async getNotes(@Param('id') id: string) {
    return this.adminUsersService.getNotes(id);
  }

  @Post(':id/notes')
  async createNote(@Param('id') id: string, @Body() dto: CreateUserNoteDto) {
    return this.adminUsersService.createNote(id, dto);
  }
}
