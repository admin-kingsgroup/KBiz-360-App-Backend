import { Router } from 'express';
import multer from 'multer';
import { asyncHandler } from '../common/asyncHandler';
import { Unauthorized, BadRequest } from '../common/errors';
import { requireAuth } from './middleware';
import { getStorage } from '../storage';

// Authenticated media upload for chat (and beyond). Saves via the storage adapter (local/S3) and
// returns attachment metadata the client embeds in a chat message. Files live in kb360_app's
// storage (local dir served at /uploads, or S3) — never in the CRM.
export const uploadsRouter: Router = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } }); // 30 MB

uploadsRouter.post(
  '/uploads',
  requireAuth,
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    if (!req.file) throw BadRequest('No file uploaded (multipart field "file")');
    const { key, url } = await getStorage().save({ buffer: req.file.buffer, filename: req.file.originalname, mimeType: req.file.mimetype });
    res.status(201).json({ url, key, name: req.file.originalname, size: req.file.size, mime: req.file.mimetype });
  }),
);
