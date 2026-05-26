import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { validate } from '../middleware/validate';
import * as businessFinanceController from '../controllers/businessFinance.controller';
import {
  businessRecurringExpenseIdParamSchema,
  createBusinessRecurringExpenseSchema,
  updateBusinessRecurringExpenseSchema,
} from '../validators/businessRecurringExpenses';

const router = Router();

router.use(authenticate);
router.get('/', businessFinanceController.listBusinessRecurringExpenses);
router.post('/', validate(createBusinessRecurringExpenseSchema), businessFinanceController.createBusinessRecurringExpense);
router.patch(
  '/:id',
  validate(businessRecurringExpenseIdParamSchema, 'params'),
  validate(updateBusinessRecurringExpenseSchema),
  businessFinanceController.updateBusinessRecurringExpense,
);
router.delete(
  '/:id',
  validate(businessRecurringExpenseIdParamSchema, 'params'),
  businessFinanceController.deleteBusinessRecurringExpense,
);

export default router;
