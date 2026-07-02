import { Types } from 'mongoose';
import { OfficeGeofenceModel, type OfficeGeofenceDoc } from './office.model';

const oid = (id: string) => new Types.ObjectId(id);

export const officeRepo = {
  // All ACTIVE offices for the given branches (a branch may have several).
  byBranchIds: (branchIds: string[]) =>
    OfficeGeofenceModel().find({ branchId: { $in: branchIds }, active: true }).lean<OfficeGeofenceDoc[]>(),

  // Every office (configured + inactive) for the given branches — for the admin list.
  allByBranchIds: (branchIds: string[]) =>
    OfficeGeofenceModel().find({ branchId: { $in: branchIds } }).lean<OfficeGeofenceDoc[]>(),

  byId: (officeId: string) =>
    (Types.ObjectId.isValid(officeId) ? OfficeGeofenceModel().findById(officeId).lean<OfficeGeofenceDoc>() : Promise.resolve(null)),

  listByTenant: (tenantId: string | null) =>
    OfficeGeofenceModel().find(tenantId ? { tenantId } : {}).lean<OfficeGeofenceDoc[]>(),

  create: (doc: Partial<OfficeGeofenceDoc>) =>
    OfficeGeofenceModel().create(doc),

  updateById: (officeId: string, set: Partial<OfficeGeofenceDoc>) =>
    OfficeGeofenceModel().findByIdAndUpdate(oid(officeId), { $set: set }, { new: true }).lean<OfficeGeofenceDoc>(),

  deleteById: (officeId: string) =>
    OfficeGeofenceModel().deleteOne({ _id: oid(officeId) }),

  // Make one office the branch default (and clear the flag on the branch's other offices).
  async setDefault(branchId: string, officeId: string): Promise<void> {
    await OfficeGeofenceModel().updateMany({ branchId }, { $set: { isDefault: false } });
    await OfficeGeofenceModel().updateOne({ _id: oid(officeId), branchId }, { $set: { isDefault: true } });
  },
};
