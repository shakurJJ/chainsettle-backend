import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { I18nService } from './i18n.service';

declare module 'express-serve-static-core' {
  interface Request {
    locale?: string;
  }
}

@Injectable()
export class LocaleMiddleware implements NestMiddleware {
  constructor(private readonly i18n: I18nService) {}

  use(req: Request, _res: Response, next: NextFunction) {
    const header = req.headers['accept-language'];
    const value = Array.isArray(header) ? header[0] : header;
    req.locale = this.i18n.resolveLocale(value);
    next();
  }
}
