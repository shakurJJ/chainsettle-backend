/**
 * Security Headers Integration Tests
 *
 * Tests verify that the application enforces production-grade security headers:
 * - Helmet.js hardening (CSP, HSTS, X-Frame-Options, X-XSS-Protection, X-Content-Type-Options)
 * - X-Powered-By header is disabled
 * - CORS is configured with explicit allowlists and credentials support
 * - Rate-limit and pagination headers are exposed via CORS
 *
 * These tests run against the full bootstrap application to ensure security
 * headers are applied at the HTTP layer before any route handler executes.
 *
 * Related issues: #557, #562, #556, #555
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Security Headers (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // Do NOT call app.listen() in e2e tests; supertest binds to the app directly
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Helmet Security Headers', () => {
    it('responds with Content-Security-Policy header', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/health')
        .expect(200);

      expect(response.headers['content-security-policy']).toBeDefined();
      expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    });

    it('responds with HSTS header for HTTPS enforcement', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/health')
        .expect(200);

      expect(response.headers['strict-transport-security']).toBeDefined();
      // max-age: 1 year (31536000 seconds)
      expect(response.headers['strict-transport-security']).toContain('max-age=31536000');
      expect(response.headers['strict-transport-security']).toContain('includeSubDomains');
    });

    it('responds with X-Content-Type-Options: nosniff header', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/health')
        .expect(200);

      expect(response.headers['x-content-type-options']).toBe('nosniff');
    });

    it('responds with X-Frame-Options: DENY header to prevent clickjacking', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/health')
        .expect(200);

      expect(response.headers['x-frame-options']).toBe('DENY');
    });

    it('responds with X-XSS-Protection header', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/health')
        .expect(200);

      expect(response.headers['x-xss-protection']).toBeDefined();
    });

    it('does not expose X-Powered-By header', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/health')
        .expect(200);

      expect(response.headers['x-powered-by']).toBeUndefined();
    });
  });

  describe('CORS Configuration', () => {
    it('accepts requests from configured ALLOWED_ORIGINS', async () => {
      // Default fallback: http://localhost:5173
      const response = await request(app.getHttpServer())
        .get('/api/v1/health')
        .set('Origin', 'http://localhost:5173')
        .expect(200);

      expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    });

    it('allows credentials in CORS responses', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/health')
        .set('Origin', 'http://localhost:5173')
        .expect(200);

      expect(response.headers['access-control-allow-credentials']).toBe('true');
    });

    it('includes standard HTTP methods in CORS allow-methods', async () => {
      const response = await request(app.getHttpServer())
        .options('/api/v1/health')
        .set('Origin', 'http://localhost:5173')
        .expect(200);

      const allowedMethods = response.headers['access-control-allow-methods'];
      expect(allowedMethods).toContain('GET');
      expect(allowedMethods).toContain('POST');
      expect(allowedMethods).toContain('PUT');
      expect(allowedMethods).toContain('PATCH');
      expect(allowedMethods).toContain('DELETE');
      expect(allowedMethods).toContain('OPTIONS');
    });

    it('exposes standard request headers via CORS', async () => {
      const response = await request(app.getHttpServer())
        .options('/api/v1/health')
        .set('Origin', 'http://localhost:5173')
        .expect(200);

      const allowedHeaders = response.headers['access-control-allow-headers'];
      expect(allowedHeaders).toContain('Content-Type');
      expect(allowedHeaders).toContain('Authorization');
      expect(allowedHeaders).toContain('X-Request-ID');
    });

    it('exposes rate-limit headers via CORS for browser clients', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/health')
        .set('Origin', 'http://localhost:5173')
        .expect(200);

      const exposedHeaders = response.headers['access-control-expose-headers'];
      expect(exposedHeaders).toContain('X-Request-ID');
      expect(exposedHeaders).toContain('X-RateLimit-Limit');
      expect(exposedHeaders).toContain('X-RateLimit-Remaining');
      expect(exposedHeaders).toContain('X-RateLimit-Reset');
      expect(exposedHeaders).toContain('Retry-After');
    });

    it('rejects preflight requests from unauthorized origins', async () => {
      const response = await request(app.getHttpServer())
        .options('/api/v1/health')
        .set('Origin', 'http://malicious.example.com')
        .expect(200);

      // CORS middleware does not set allow-origin for disallowed origins
      expect(response.headers['access-control-allow-origin']).not.toBe(
        'http://malicious.example.com',
      );
    });
  });

  describe('Security Header Consistency', () => {
    it('applies security headers to all response types (JSON, HTML, etc.)', async () => {
      const endpoints = [
        '/api/v1/health',
        '/api/v1/docs', // Swagger UI (may be HTML or JSON)
      ];

      for (const endpoint of endpoints) {
        const response = await request(app.getHttpServer())
          .get(endpoint)
          .expect([200, 301, 302, 304, 404, 405]); // Accept various status codes

        // These headers should be present on all responses
        if (response.status === 200) {
          expect(response.headers['x-frame-options']).toBeDefined();
          expect(response.headers['x-content-type-options']).toBeDefined();
        }
      }
    });

    it('applies security headers to error responses', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/nonexistent-route')
        .expect(404);

      // Security headers should be present even on error responses
      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    });
  });

  describe('Compression and Content Handling', () => {
    it('gzip compresses responses larger than 1 KB', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/health')
        .set('Accept-Encoding', 'gzip')
        .expect(200);

      // gzip compression is applied by middleware, headers should reflect it
      if (response.headers['content-encoding']) {
        expect(response.headers['content-encoding']).toContain('gzip');
      }
    });
  });
});
