import { User, UserRole } from '@prisma/client';
import { AppError, ErrorCodes } from './errors';

export function canViewBilling(role: UserRole): boolean {
  return role === 'admin' || role === 'salesman';
}

export function canManageBilling(role: UserRole): boolean {
  return role === 'admin';
}

export function assertCanViewBilling(user: User): void {
  if (!canViewBilling(user.role)) {
    throw new AppError(ErrorCodes.FORBIDDEN, 'Not allowed to view billing', 403);
  }
}

export function assertCanManageBilling(user: User): void {
  if (!canManageBilling(user.role)) {
    throw new AppError(ErrorCodes.FORBIDDEN, 'Only admins can manage billing', 403);
  }
}
