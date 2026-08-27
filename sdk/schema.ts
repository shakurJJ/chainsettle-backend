/**
 * This file was auto-generated / curated for @chainsettle/sdk.
 * Do not edit by hand for long — run `npm run generate:sdk` to refresh from NestJS Swagger.
 */

export interface paths {
  '/api/v1/auth/nonce': {
    get: {
      parameters: {
        query: { address: string };
      };
      responses: {
        200: {
          content: {
            'application/json': {
              success?: boolean;
              data?: { nonce?: string };
            };
          };
        };
      };
    };
  };
  '/api/v1/auth/login': {
    post: {
      requestBody: {
        content: {
          'application/json': {
            stellarAddress: string;
            signedNonce: string;
            signature: string;
          };
        };
      };
      responses: {
        200: {
          content: {
            'application/json': {
              success?: boolean;
              data?: { accessToken?: string; user?: Record<string, unknown> };
            };
          };
        };
      };
    };
  };
  '/api/v1/shipments': {
    get: {
      parameters: {
        query?: {
          page?: number;
          limit?: number;
          status?: string;
        };
      };
      responses: {
        200: {
          content: {
            'application/json': {
              success?: boolean;
              data?: unknown;
              timestamp?: string;
            };
          };
        };
      };
    };
    post: {
      requestBody: {
        content: {
          'application/json': Record<string, unknown>;
        };
      };
      responses: {
        201: {
          content: {
            'application/json': {
              success?: boolean;
              data?: unknown;
              timestamp?: string;
            };
          };
        };
      };
    };
  };
  '/api/v1/shipments/{id}': {
    get: {
      parameters: {
        path: { id: string };
      };
      responses: {
        200: {
          content: {
            'application/json': {
              success?: boolean;
              data?: unknown;
              timestamp?: string;
            };
          };
        };
      };
    };
  };
  '/api/v1/notifications': {
    get: {
      responses: {
        200: {
          content: {
            'application/json': {
              success?: boolean;
              data?: unknown;
              timestamp?: string;
            };
          };
        };
      };
    };
  };
  '/api/v1/events': {
    get: {
      responses: {
        200: {
          content: {
            'application/json': {
              success?: boolean;
              data?: unknown;
              timestamp?: string;
            };
          };
        };
      };
    };
  };
  '/api/v1/health': {
    get: {
      responses: {
        200: {
          content: {
            'application/json': {
              success?: boolean;
              data?: unknown;
              timestamp?: string;
            };
          };
        };
      };
    };
  };
  '/api/v1/admin/users/{id}/impersonate': {
    post: {
      parameters: {
        path: { id: string };
      };
      responses: {
        200: {
          content: {
            'application/json': {
              success?: boolean;
              data?: {
                accessToken?: string;
                expiresIn?: string;
                targetUser?: Record<string, unknown>;
              };
            };
          };
        };
      };
    };
  };
  '/api/v1/users/me': {
    get: {
      responses: {
        200: {
          content: {
            'application/json': {
              success?: boolean;
              data?: unknown;
              timestamp?: string;
            };
          };
        };
      };
    };
  };
}

export type components = {
  schemas: {
    Envelope: {
      success?: boolean;
      data?: unknown;
      timestamp?: string;
    };
  };
};

export type operations = Record<string, never>;
