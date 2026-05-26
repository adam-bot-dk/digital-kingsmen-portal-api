import { Request, Response, NextFunction } from 'express';
import * as authService from '../services/auth.service';
import { success } from '../lib/apiResponse';
import { AppError, ErrorCodes } from '../lib/errors';

export async function register(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await authService.register(req.body);
    return success(res, result, 201);
  } catch (err) {
    next(err);
  }
}

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await authService.login(req.body.email, req.body.password);
    return success(res, result);
  } catch (err) {
    next(err);
  }
}

export async function logout(_req: Request, res: Response) {
  return success(res, { message: 'Logged out successfully' });
}

export async function me(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await authService.getMe(req.user!.id);
    return success(res, data);
  } catch (err) {
    next(err);
  }
}

export async function invitePreview(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.query.token;
    if (typeof token !== 'string' || !token.trim()) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invite token is required', 400);
    }
    const data = await authService.previewInvite(token);
    return success(res, data);
  } catch (err) {
    next(err);
  }
}
