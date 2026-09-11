import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DeliveryInspectionDrawer,
  extractWebhookErrorMessage
} from '../pages/DeveloperPage';
import type { WebhookDelivery } from '../api/webhook';

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
});
