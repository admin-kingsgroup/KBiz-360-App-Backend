import { Router } from 'express';
import multer from 'multer';
import { asyncHandler } from '../../common/asyncHandler';
import { Unauthorized, BadRequest } from '../../common/errors';
import { requireAuth } from '../auth/auth.middleware';
import { uploadsService } from './uploads.service';

export const uploadsRouter: Router = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// POST /uploads — multipart field "file" → { id, url }.
uploadsRouter.post(
  '/',
  requireAuth,
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    if (!req.file) throw BadRequest('No file uploaded (multipart field "file")');
    res.status(201).json(await uploadsService.upload(req.auth.userId, req.file));
  }),
);
