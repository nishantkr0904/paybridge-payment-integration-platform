import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DeveloperPortalAccessDenied,
  WebhookRegistrationForm,
  WebhookEndpointsTable,
  DeliveryInspectionDrawer,
  extractWebhookErrorMessage
} from '../pages/DeveloperPage';
import type { WebhookDelivery, WebhookEndpoint } from '../api/webhook';

describe('Merchant Developer Portal & Delivery Inspection Drawer (Task 1)', () => {
  const mockDeliveries: WebhookDelivery[] = [
    {
      id: 34,
      endpointId: 13,
      eventType: 'payment.succeeded',
      payload: {
        id: 'evt_demo_pay_succ_001',
        type: 'payment.succeeded',
        createdAt: '2026-09-11T12:00:00.000Z',
        data: {
          orderId: 9155,
          orderRef: 'ORD_DEV_DEMO_001',
          transactionId: 10842,
          amount: 25000,
          currency: 'INR',
          status: 'success'
        }
      },
      status: 'success',
      responseStatus: 200,
      createdAt: '2026-09-11T13:54:53.000Z'
    },
    {
      id: 35,
      endpointId: 13,
      eventType: 'payment.failed',
      payload: {
        id: 'evt_demo_pay_fail_002',
        type: 'payment.failed',
        createdAt: '2026-09-11T12:15:00.000Z',
        data: {
          orderId: 9156,
          orderRef: 'ORD_DEV_DEMO_002',
          transactionId: 10843,
          amount: 45000,
          currency: 'INR',
          status: 'failed',
          failureCode: 'INSUFFICIENT_FUNDS',
          failureMessage: 'Debit card issuer returned decline code 51'
        }
      },
      status: 'failed',
      responseStatus: 500,
      createdAt: '2026-09-11T13:54:53.000Z'
    },
    {
      id: 36,
      endpointId: 13,
      eventType: 'recovery.started',
      payload: {
        id: 'evt_demo_rec_start_003',
        type: 'recovery.started',
        createdAt: '2026-09-11T12:16:00.000Z',
        data: {
          caseId: 14,
          caseRef: 'CASE_DEV_DEMO_003',
          orderRef: 'ORD_DEV_DEMO_002',
          recoverableAmount: 45000,
          currency: 'INR',
          strategy: 'OFFER_INCENTIVE',
          autonomyTier: 'T2',
          status: 'awaiting_approval'
        }
      },
      status: 'success',
      responseStatus: 200,
      createdAt: '2026-09-11T13:54:53.000Z'
    }
  ];

  describe('1. Delivery Inspection Drawer Rendering', () => {
    it('renders delivery header, event type, status, and close button', () => {
      const delivery = mockDeliveries[0];
      const onClose = vi.fn();
      const markup = renderToStaticMarkup(
        <DeliveryInspectionDrawer delivery={delivery} onClose={onClose} />
      );

      expect(markup).toContain('data-testid="delivery-detail-drawer"');
      expect(markup).toContain('Webhook Delivery');
      expect(markup).toContain('payment.succeeded');
      expect(markup).toContain('success');
      expect(markup).toContain('data-testid="close-delivery-drawer-btn"');
    });

    it('renders delivery metadata grid including ID, endpoint, response status, and timestamp', () => {
      const delivery = mockDeliveries[0];
      const onClose = vi.fn();
      const markup = renderToStaticMarkup(
        <DeliveryInspectionDrawer delivery={delivery} onClose={onClose} />
      );

      expect(markup).toContain('data-testid="delivery-detail-id"');
      expect(markup).toContain('#34');
      expect(markup).toContain('data-testid="delivery-detail-endpoint-id"');
      expect(markup).toContain('Endpoint #13');
      expect(markup).toContain('data-testid="delivery-detail-response-status"');
      expect(markup).toContain('HTTP 200');
      expect(markup).toContain('data-testid="delivery-detail-timestamp"');
    });

    it('renders formatted JSON payload matching the delivery payload', () => {
      const delivery = mockDeliveries[0];
      const onClose = vi.fn();
      const markup = renderToStaticMarkup(
        <DeliveryInspectionDrawer delivery={delivery} onClose={onClose} />
      );

      expect(markup).toContain('data-testid="delivery-payload-content"');
      expect(markup).toContain('evt_demo_pay_succ_001');
      expect(markup).toContain('ORD_DEV_DEMO_001');
      expect(markup).toContain('25000');
    });

    it('renders failed delivery with HTTP 500 error code and failure diagnostic data', () => {
      const delivery = mockDeliveries[1];
      const onClose = vi.fn();
      const markup = renderToStaticMarkup(
        <DeliveryInspectionDrawer delivery={delivery} onClose={onClose} />
      );

      expect(markup).toContain('payment.failed');
      expect(markup).toContain('HTTP 500');
      expect(markup).toContain('failed');
      expect(markup).toContain('INSUFFICIENT_FUNDS');
      expect(markup).toContain('Debit card issuer returned decline code 51');
    });

    it('renders recovery.started delivery with AI recovery context intact', () => {
      const delivery = mockDeliveries[2];
      const onClose = vi.fn();
      const markup = renderToStaticMarkup(
        <DeliveryInspectionDrawer delivery={delivery} onClose={onClose} />
      );

      expect(markup).toContain('recovery.started');
      expect(markup).toContain('CASE_DEV_DEMO_003');
      expect(markup).toContain('OFFER_INCENTIVE');
      expect(markup).toContain('awaiting_approval');
    });
  });

  describe('2. Anti-Stale Delivery Switching', () => {
    it('switches cleanly from payment.succeeded to payment.failed without retaining stale fields', () => {
      const onClose = vi.fn();

      const markup1 = renderToStaticMarkup(
        <DeliveryInspectionDrawer delivery={mockDeliveries[0]} onClose={onClose} />
      );
      expect(markup1).toContain('#34');
      expect(markup1).toContain('HTTP 200');
      expect(markup1).toContain('evt_demo_pay_succ_001');
      expect(markup1).not.toContain('evt_demo_pay_fail_002');
      expect(markup1).not.toContain('INSUFFICIENT_FUNDS');

      const markup2 = renderToStaticMarkup(
        <DeliveryInspectionDrawer delivery={mockDeliveries[1]} onClose={onClose} />
      );
      expect(markup2).toContain('#35');
      expect(markup2).toContain('HTTP 500');
      expect(markup2).toContain('evt_demo_pay_fail_002');
      expect(markup2).toContain('INSUFFICIENT_FUNDS');
      expect(markup2).not.toContain('evt_demo_pay_succ_001');
      expect(markup2).not.toContain('ORD_DEV_DEMO_001');
    });
  });

  describe('3. Webhook Registration Error Extraction', () => {
    it('extracts field error from validation error response (SSRF / non-HTTPS)', () => {
      const mockErr = {
        response: {
          data: {
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Request validation failed.',
              details: {
                fieldErrors: {
                  url: ['Webhook URL must use HTTPS for public endpoints.']
                }
              }
            }
          }
        }
      };
      const msg = extractWebhookErrorMessage(mockErr);
      expect(msg).toBe('Webhook URL must use HTTPS for public endpoints.');
    });

    it('extracts private IP rejection message', () => {
      const mockErr = {
        response: {
          data: {
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Request validation failed.',
              details: {
                fieldErrors: {
                  url: ['Webhook URL cannot point to a private or reserved IP address.']
                }
              }
            }
          }
        }
      };
      const msg = extractWebhookErrorMessage(mockErr);
      expect(msg).toBe('Webhook URL cannot point to a private or reserved IP address.');
    });

    it('falls back to top-level error message when no field errors exist', () => {
      const mockErr = {
        response: {
          data: {
            error: {
              code: 'FORBIDDEN',
              message: 'Access denied to webhook configuration.'
            }
          }
        }
      };
      const msg = extractWebhookErrorMessage(mockErr);
      expect(msg).toBe('Access denied to webhook configuration.');
    });

    it('falls back to standard Error message when no response object', () => {
      const mockErr = new Error('Network timeout');
      const msg = extractWebhookErrorMessage(mockErr);
      expect(msg).toBe('Network timeout');
    });

    it('falls back to default message when error is completely empty', () => {
      const msg = extractWebhookErrorMessage({});
      expect(msg).toBe('Failed to add webhook endpoint');
    });
  });

  describe('4. Developer Portal Access Denied Component (RBAC: webhook:read)', () => {
    it('renders unauthorized banner with data-testid="developer-portal-unauthorized"', () => {
      const markup = renderToStaticMarkup(<DeveloperPortalAccessDenied />);

      expect(markup).toContain('data-testid="developer-portal-unauthorized"');
      expect(markup).toContain('Developer Portal Access Restricted');
      expect(markup).toContain('webhook:read');
    });
  });

  describe('5. Webhook Registration Form RBAC Boundaries (RBAC: webhook:manage)', () => {
    it('renders enabled input and button when user has webhook:manage permission', () => {
      const markup = renderToStaticMarkup(
        <WebhookRegistrationForm
          url="https://merchant.example.com/webhook"
          onUrlChange={() => {}}
          onSubmit={() => {}}
          isPending={false}
          canManageWebhooks={true}
          formError={null}
        />
      );

      expect(markup).toContain('https://merchant.example.com/webhook');
      expect(markup).toContain('Add Endpoint');
      expect(markup).not.toContain('disabled=""');
      expect(markup).not.toContain('data-testid="webhook-manage-unauthorized-notice"');
    });

    it('renders disabled input, disabled button, and unauthorized notice when user lacks webhook:manage permission', () => {
      const markup = renderToStaticMarkup(
        <WebhookRegistrationForm
          url=""
          onUrlChange={() => {}}
          onSubmit={() => {}}
          isPending={false}
          canManageWebhooks={false}
          formError={null}
        />
      );

      expect(markup).toContain('disabled=""');
      expect(markup).toContain('data-testid="webhook-manage-unauthorized-notice"');
      expect(markup).toContain('webhook:manage');
    });

    it('renders form error message when formError is provided', () => {
      const markup = renderToStaticMarkup(
        <WebhookRegistrationForm
          url="http://insecure.internal"
          onUrlChange={() => {}}
          onSubmit={() => {}}
          isPending={false}
          canManageWebhooks={true}
          formError="Webhook URL must use HTTPS for public endpoints."
        />
      );

      expect(markup).toContain('data-testid="webhook-form-error"');
      expect(markup).toContain('Webhook URL must use HTTPS for public endpoints.');
    });
  });

  describe('6. Webhook Endpoints Table RBAC Boundaries (RBAC: webhook:secret:read)', () => {
    const mockEndpoints: WebhookEndpoint[] = [
      {
        id: 13,
        merchantId: 1,
        url: 'https://webhook.site/paybridge-demo-ep1',
        secret: 'whsec_demo_secret_xyz1234567890abcdef',
        isActive: true,
        createdAt: '2026-09-11T12:00:00.000Z',
        updatedAt: '2026-09-11T12:00:00.000Z'
      }
    ];

    it('renders Reveal button and reveals secret when canReadSecret is true and toggled', () => {
      // Hidden state
      const markupHidden = renderToStaticMarkup(
        <WebhookEndpointsTable
          endpoints={mockEndpoints}
          canReadSecret={true}
          showSecret={{ 13: false }}
          onToggleSecret={() => {}}
        />
      );
      expect(markupHidden).toContain('whsec_••••••••••••••••••••••••');
      expect(markupHidden).toContain('data-testid="toggle-secret-13"');
      expect(markupHidden).toContain('Reveal');
      expect(markupHidden).not.toContain('whsec_demo_secret_xyz1234567890abcdef');

      // Revealed state
      const markupRevealed = renderToStaticMarkup(
        <WebhookEndpointsTable
          endpoints={mockEndpoints}
          canReadSecret={true}
          showSecret={{ 13: true }}
          onToggleSecret={() => {}}
        />
      );
      expect(markupRevealed).toContain('whsec_demo_secret_xyz1234567890abcdef');
      expect(markupRevealed).toContain('Hide');
    });

    it('masks secret and displays Locked badge without Reveal button when canReadSecret is false', () => {
      const markup = renderToStaticMarkup(
        <WebhookEndpointsTable
          endpoints={mockEndpoints}
          canReadSecret={false}
          showSecret={{ 13: true }} // even if client attempted to set showSecret to true
          onToggleSecret={() => {}}
        />
      );

      expect(markup).toContain('whsec_••••••••••••••••••••••••');
      expect(markup).not.toContain('whsec_demo_secret_xyz1234567890abcdef');
      expect(markup).not.toContain('data-testid="toggle-secret-13"');
      expect(markup).toContain('data-testid="secret-locked-13"');
      expect(markup).toContain('Locked');
    });

    it('renders empty table row when no endpoints configured', () => {
      const markup = renderToStaticMarkup(
        <WebhookEndpointsTable
          endpoints={[]}
          canReadSecret={true}
          showSecret={{}}
          onToggleSecret={() => {}}
        />
      );

      expect(markup).toContain('No webhook endpoints configured.');
    });
  });
});