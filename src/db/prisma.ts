import { PrismaClient } from '@prisma/client';

// Single PrismaClient instance shared across the app (avoids connection-pool exhaustion in dev).
export const prisma = new PrismaClient();

export async function connectDb(): Promise<void> {
  await prisma.$connect();
}

export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect();
}
