import { IsNotEmpty, MaxLength } from 'class-validator';

export class NoteDto {
  @IsNotEmpty()
  @MaxLength(2000)
  body: string;
}
