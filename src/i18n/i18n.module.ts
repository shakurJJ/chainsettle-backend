import { Global, Module } from '@nestjs/common';
import { I18nService } from './i18n.service';
import { LocaleMiddleware } from './locale.middleware';

@Global()
@Module({
  providers: [I18nService, LocaleMiddleware],
  exports: [I18nService, LocaleMiddleware],
})
export class I18nModule {}
