import { User, UserRole } from '@prisma/client';
import { AppError, ErrorCodes } from './errors';

export function canViewMonthlyServiceFinancials(role: UserRole): boolean {
  return role === 'admin' || role === 'salesman';
}

export function canManageMonthlyServices(role: UserRole): boolean {
  return role === 'admin' || role === 'salesman';
}

export function assertCanManageMonthlyServices(user: User): void {
  if (!canManageMonthlyServices(user.role)) {
    throw new AppError(
      ErrorCodes.FORBIDDEN,
      'Only admins and salesmen can change monthly services',
      403,
    );
  }
}
