import { Router } from 'express';
import * as billingController from '../controllers/billing.controller';
import { authenticate } from '../middleware/authenticate';
import { validate } from '../middleware/validate';
import { companyIdParamSchema } from '../validators/monthlyServices';
import { createBillingPeriodSchema } from '../validators/billing';

const router = Router({ mergeParams: true });
router.use(authenticate);

router.get('/periods', validate(companyIdParamSchema, 'params'), billingController.listCompanyPeriods);
router.get(
  '/periods/current',
  validate(companyIdParamSchema, 'params'),
  billingController.getCurrentPeriodForCompany,
);
router.post(
  '/periods',
  validate(companyIdParamSchema, 'params'),
  validate(createBillingPeriodSchema),
  billingController.createCompanyPeriod,
);

export default router;
