import { fieldTitle } from '@/domain/customFields';
import { describe, expect, test } from 'vitest';

describe('fieldTitle', () => {
  test.each([
    ['projectType', 'Project Type'],
    ['project_type', 'Project Type'],
    ['PROJECT_TYPE', 'Project Type'],
    ['budget-range', 'Budget Range'],
    ['referralSource', 'Referral Source'],
    ['estimatedValue', 'Estimated Value'],
    ['newsletter', 'Newsletter'],
    ['address1', 'Address 1'],
    ['address_line_2', 'Address Line 2'],
    ['userID', 'User ID'],
    ['APIKey', 'API Key'],
    ['HTTPStatus', 'HTTP Status'],
    ['httpStatusCode', 'Http Status Code'],
    ['utm.source', 'Utm Source'],
    ['Project Type', 'Project Type'],
    ['__foo__bar__', 'Foo Bar'],
    ['i', 'I'],
    ['SSN', 'SSN'],
    ['über_stadt', 'Über Stadt'],
    ['', ''],
    ['___', ''],
  ])('turns %j into %j', (key, expected) => {
    expect(fieldTitle(key)).toBe(expected);
  });

  test('is idempotent', () => {
    for (const key of ['projectType', 'PROJECT_TYPE', 'userID', 'utm.source']) {
      expect(fieldTitle(fieldTitle(key))).toBe(fieldTitle(key));
    }
  });
});
