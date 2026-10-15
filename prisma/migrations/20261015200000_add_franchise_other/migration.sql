-- AlterEnum
-- Story 13.5 (FR-50, AD-33): ADD VALUE only; the value is NOT used in this
-- migration (PostgreSQL cannot use a new enum value in the same transaction).
ALTER TYPE "Franchise" ADD VALUE 'OTHER';
