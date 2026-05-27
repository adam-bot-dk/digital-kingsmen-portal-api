import { Router } from 'express';
import * as billingController from '../controllers/billing.controller';
import { authenticate } from '../middleware/authenticate';
import { validate } from '../middleware/validate';
import { idParamSchema } from '../validators/common';
import {
  bulkBillingPeriodsSchema,
  listBillingPeriodsQuerySchema,
  updateBillingPeriodSchema,
} from '../validators/billing';

const router = Router();
router.use(authenticate);

router.get(
  '/periods',
  validate(listBillingPeriodsQuerySchema, 'query'),
  billingController.listPeriods,
);
router.post('/periods/bulk', validate(bulkBillingPeriodsSchema), billingController.bulkImport);
router.post('/generate', billingController.generate);
router.patch(
  '/periods/:id',
  validate(idParamSchema, 'params'),
  validate(updateBillingPeriodSchema),
  billingController.updatePeriod,
);

export default router;
