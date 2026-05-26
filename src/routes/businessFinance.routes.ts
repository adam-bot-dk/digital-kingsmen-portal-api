import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import * as businessFinanceController from '../controllers/businessFinance.controller';

const router = Router();

router.use(authenticate);
router.get('/summary', businessFinanceController.getSummary);

export default router;
