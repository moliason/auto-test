import { describe, expect, test } from 'vitest';
import { isImage } from './isImage';
import { AttachmentType } from '@/types/case';

describe('attachment control', () => {
  test('isImage', () => {
    const sampleCaseAttachment: AttachmentType['caseAttachments'] = {
      createdAt: new Date(),
      updatedAt: new Date(),
      caseId: 1,
      attachmentId: 1,
    };

    const sampleAttachment: AttachmentType = {
      id: 1,
      title: '',
      detail: '',
      filename: '',
      createdAt: new Date(),
      updatedAt: new Date(),
      caseAttachments: sampleCaseAttachment,
    };

    sampleAttachment.filename = 'abc.png';
    expect(isImage(sampleAttachment)).toBe(true);

    sampleAttachment.filename = 'abc.mp3';
    expect(isImage(sampleAttachment)).toBe(false);
  });
});
