import { registerDecorator, type ValidationOptions } from 'class-validator';
import { GradingCompany } from '../../catalog/grading-company.js';

/**
 * Story 11.1 (AD-18): the decorated field (`certNumber`/`gradeValue`) is only
 * accepted when the same DTO carries a `gradingCompany` other than `RAW`.
 * Intended to be combined with `@IsOptional()` (an absent field passes).
 */
export function RequiresGradedCompany(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (target, propertyName) => {
    registerDecorator({
      name: 'requiresGradedCompany',
      target: target.constructor,
      propertyName: propertyName as string,
      options: {
        message: `${String(propertyName)} requires gradingCompany to be PSA, BGS or CGC (not RAW)`,
        ...validationOptions,
      },
      validator: {
        validate(_value: unknown, args) {
          const company = (args?.object as { gradingCompany?: unknown })
            .gradingCompany;
          return (
            typeof company === 'string' &&
            company !== GradingCompany.RAW &&
            Object.values(GradingCompany).includes(company as GradingCompany)
          );
        },
      },
    });
  };
}
