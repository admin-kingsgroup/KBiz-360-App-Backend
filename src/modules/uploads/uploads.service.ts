import { prisma } from '../../db/prisma';
import { writeAudit } from '../../common/audit';
import { getStorage } from '../../storage';

export interface UploadedFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

export const uploadsService = {
  async upload(userId: string, file: UploadedFile): Promise<{ id: string; url: string }> {
    const { key, url } = await getStorage().save({ buffer: file.buffer, filename: file.originalname, mimeType: file.mimetype });
    const row = await prisma.upload.create({
      data: { storageKey: key, url, mimeType: file.mimetype, sizeBytes: file.size, uploadedById: userId },
    });
    await writeAudit({ actorId: userId, action: 'UPLOAD', entity: 'Upload', entityId: row.id, after: { url, mimeType: file.mimetype, sizeBytes: file.size } });
    return { id: row.id, url: row.url };
  },
};
