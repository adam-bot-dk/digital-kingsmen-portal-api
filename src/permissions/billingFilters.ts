import { Prisma, User } from '@prisma/client';
import { companyWhereForUser } from './filters';

export async function billingPeriodWhereForUser(user: User): Promise<Prisma.CompanyBillingPeriodWhereInput> {
  if (user.role === 'admin') return {};
  if (user.role === 'salesman') {
    const companyScope = await companyWhereForUser(user);
    return { company: companyScope };
  }
  return { id: 'never' };
}
