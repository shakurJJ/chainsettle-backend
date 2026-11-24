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
    let localeValue: string | undefined;

    if (req.query && req.query.lang) {
      localeValue = Array.isArray(req.query.lang)
        ? (req.query.lang[0] as string)
        : (req.query.lang as string);
    }

    if (!localeValue) {
      const header = req.headers['accept-language'];
      localeValue = Array.isArray(header) ? header[0] : header;
    }

    req.locale = this.i18n.resolveLocale(localeValue);
    next();
  }
}
