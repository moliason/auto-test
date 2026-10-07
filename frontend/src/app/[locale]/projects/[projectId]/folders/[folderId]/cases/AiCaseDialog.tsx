'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Button,
  Checkbox,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Textarea,
} from '@heroui/react';
import Config from '@/config/config';

type Draft = {
  title: string;
  description: string;
  preConditions: string;
  expectedResults: string;
  priority: number;
  steps: { step: string; result: string }[];
};

type Props = {
  folderId: string;
  token: string;
  onClose: () => void;
  onSaved: () => void;
};

export default function AiCaseDialog({ folderId, token, onClose, onSaved }: Props) {
  const t = useTranslations('AiCases');
  const [requirements, setRequirements] = useState('');
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const valid =
    drafts.length > 0 &&
    drafts.every(
      (draft) =>
        draft.title.trim() &&
        draft.expectedResults.trim() &&
        draft.steps.every((step) => step.step.trim() && step.result.trim())
    );

  return (
    <Modal
      isOpen
      size="4xl"
      scrollBehavior="inside"
      isDismissable={false}
      isKeyboardDismissDisabled={busy}
      hideCloseButton={busy}
      onClose={onClose}
    >
      <ModalContent>
        <ModalHeader>{t('title')}</ModalHeader>
        <ModalBody>
          <p className="text-sm text-default-500">{t(drafts.length ? 'reviewHint' : 'inputHint')}</p>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          {!drafts.length ? (
            <Textarea
              label={t('requirements')}
              placeholder={t('placeholder')}
              minRows={6}
              maxRows={12}
              maxLength={10000}
              value={requirements}
              onValueChange={setRequirements}
              isDisabled={busy}
              description={`${requirements.length} / 10000`}
            />
          ) : (
            <div className="space-y-4" onChange={() => setReviewed(false)}>
              {drafts.map((draft, index) => (
                <fieldset key={index} disabled={busy} className="min-w-0 rounded-lg border border-divider p-3 sm:p-4">
                  <legend className="px-1 text-sm font-medium">
                    {t('draft')} {index + 1}
                  </legend>
                  <div className="space-y-3">
                    <Input
                      label={t('caseTitle')}
                      value={draft.title}
                      maxLength={255}
                      isRequired
                      onValueChange={(title) =>
                        setDrafts((items) => items.map((item, i) => (i === index ? { ...item, title } : item)))
                      }
                    />
                    <label className="flex items-center gap-3 text-sm">
                      {t('priority')}
                      <select
                        className="rounded-md border border-divider bg-content1 p-2"
                        value={draft.priority}
                        onChange={(event) =>
                          setDrafts((items) =>
                            items.map((item, i) =>
                              i === index ? { ...item, priority: Number(event.target.value) } : item
                            )
                          )
                        }
                      >
                        {['critical', 'high', 'medium', 'low'].map((level, value) => (
                          <option key={level} value={value}>
                            {t(level)}
                          </option>
                        ))}
                      </select>
                    </label>
                    {(['description', 'preConditions', 'expectedResults'] as const).map((field) => (
                      <Textarea
                        key={field}
                        label={t(field)}
                        value={draft[field]}
                        maxLength={2000}
                        isRequired={field === 'expectedResults'}
                        onValueChange={(value) =>
                          setDrafts((items) =>
                            items.map((item, i) => (i === index ? { ...item, [field]: value } : item))
                          )
                        }
                      />
                    ))}
                    {draft.steps.map((step, stepIndex) => (
                      <div key={stepIndex} className="grid min-w-0 gap-3 sm:grid-cols-2">
                        {(['step', 'result'] as const).map((field) => (
                          <Textarea
                            key={field}
                            label={`${stepIndex + 1}. ${t(field)}`}
                            value={step[field]}
                            maxLength={1500}
                            isRequired
                            onValueChange={(value) =>
                              setDrafts((items) =>
                                items.map((item, i) =>
                                  i === index
                                    ? {
                                        ...item,
                                        steps: item.steps.map((entry, j) =>
                                          j === stepIndex ? { ...entry, [field]: value } : entry
                                        ),
                                      }
                                    : item
                                )
                              )
                            }
                          />
                        ))}
                      </div>
                    ))}
                    <Button
                      size="sm"
                      variant="light"
                      color="danger"
                      isDisabled={busy}
                      onPress={() => {
                        setDrafts((items) => items.filter((_, i) => i !== index));
                        setReviewed(false);
                      }}
                    >
                      {t('remove')}
                    </Button>
                  </div>
                </fieldset>
              ))}
            </div>
          )}
          {!!drafts.length && (
            <Checkbox isSelected={reviewed} onValueChange={setReviewed} isDisabled={busy}>
              {t('reviewed')}
            </Checkbox>
          )}
        </ModalBody>
        <ModalFooter className="flex-wrap">
          <Button variant="light" isDisabled={busy} onPress={onClose}>
            {t('close')}
          </Button>
          <Button
            color="primary"
            isLoading={busy}
            isDisabled={busy || (drafts.length ? !reviewed || !valid : !requirements.trim())}
            onPress={async () => {
              if (busy) return;
              const saving = drafts.length > 0;
              setBusy(true);
              setError('');
              let saved = false;
              try {
                const response = await fetch(
                  `${Config.apiServer}/cases/ai/${saving ? 'save' : 'generate'}?folderId=${encodeURIComponent(folderId)}`,
                  {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                    body: JSON.stringify(saving ? { cases: drafts, reviewed } : { requirements }),
                  }
                );
                const data = await response.json().catch(() => ({}));
                if (!response.ok) {
                  const code = response.status === 401 || response.status === 403 ? 'forbidden' : data.code;
                  setError(t(code && t.has(code) ? code : saving ? 'saveFailed' : 'providerFailed'));
                } else if (saving) {
                  saved = true;
                } else {
                  setDrafts(data.cases);
                  setReviewed(false);
                }
              } catch {
                setError(t(saving ? 'saveFailed' : 'providerFailed'));
              } finally {
                setBusy(false);
              }
              if (saved) onSaved();
            }}
          >
            {t(drafts.length ? 'save' : 'generate')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
