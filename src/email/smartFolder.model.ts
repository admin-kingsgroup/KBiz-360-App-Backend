import { Schema, Types, type Model } from 'mongoose';
import { appDb } from '../mongo/connection';

// A "smart folder": a real Outlook mail folder (graphFolderId) + a routing rule. New inbox mail whose
// sender matches any `from` entry (a domain like "travkings.com" or a full address) is auto-moved into
// it by the email poller. Stored in kb360_app, per kb360 user.
export interface SmartFolderDoc {
  _id: Types.ObjectId;
  userId: string;
  name: string;
  graphFolderId: string;
  from: string[]; // sender match substrings (domain or address), lower-cased on save
  createdAt: Date;
  updatedAt: Date;
}

const SmartFolderSchema = new Schema<SmartFolderDoc>(
  {
    userId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    graphFolderId: { type: String, required: true },
    from: { type: [String], default: [] },
  },
  { timestamps: true, collection: 'email_smart_folders' },
);

let _model: Model<SmartFolderDoc> | null = null;
function SmartFolderModel(): Model<SmartFolderDoc> {
  if (!_model) _model = appDb().model<SmartFolderDoc>('EmailSmartFolder', SmartFolderSchema);
  return _model;
}

export const smartFolderRepo = {
  listForUser: (userId: string) => SmartFolderModel().find({ userId }).sort({ createdAt: 1 }).lean<SmartFolderDoc[]>(),
  byId: (userId: string, id: string) =>
    (Types.ObjectId.isValid(id) ? SmartFolderModel().findOne({ _id: new Types.ObjectId(id), userId }).lean<SmartFolderDoc>() : Promise.resolve(null)),
  create: (doc: Pick<SmartFolderDoc, 'userId' | 'name' | 'graphFolderId' | 'from'>) => SmartFolderModel().create(doc),
  remove: (userId: string, id: string) =>
    (Types.ObjectId.isValid(id) ? SmartFolderModel().deleteOne({ _id: new Types.ObjectId(id), userId }) : Promise.resolve({ deletedCount: 0 })),
};
