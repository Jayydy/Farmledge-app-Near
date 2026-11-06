import { useEffect } from 'react';

import { useI18n } from '../../i18n';

interface KeypadProps {
  value: string;
  onChange: (value: string) => void;
  /** Allow one decimal point (moisture, kg). */
  decimal?: boolean;
  /** Show dots instead of digits (PINs). */
  masked?: boolean;
  maxLength: number;
  placeholder?: string;
  label: string;
}

/**
 * A large on-screen number pad: every numeric field uses it, so the custodian
 * never has to find digits on a small keyboard. A physical keyboard works too.
 */
export function Keypad({
  value,
  onChange,
  decimal = false,
  masked = false,
  maxLength,
  placeholder = '',
  label,
}: KeypadProps) {
  const press = (key: string) => {
    if (key === 'back') {
      onChange(value.slice(0, -1));
    } else if (key === 'clear') {
      onChange('');
    } else if (key === '.') {
      if (decimal && !value.includes('.') && value.length < maxLength)
        onChange(value === '' ? '0.' : `${value}.`);
    } else if (value.length < maxLength) {
      onChange(value + key);
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;
      if (/^\d$/.test(event.key)) press(event.key);
      else if (event.key === '.' || event.key === ',') press('.');
      else if (event.key === 'Backspace') press('back');
      else if (event.key === 'Escape') press('clear');
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  });

  const { t } = useI18n();
  const shown = masked ? '●'.repeat(value.length) : value;
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', decimal ? '.' : 'clear', '0', 'back'];
  return (
    <div className="keypad">
      <output
        className="keypad__display"
        aria-label={label}
        aria-live="polite"
        data-empty={value === ''}
      >
        {value === '' ? placeholder : shown}
      </output>
      <div className="keypad__keys">
        {keys.map((key) => (
          <button
            key={key}
            type="button"
            className="keypad__key"
            onClick={() => {
              press(key);
            }}
            aria-label={key === 'back' ? t('delete') : key === 'clear' ? t('clear') : key}
          >
            {key === 'back' ? '⌫' : key === 'clear' ? t('clear') : key}
          </button>
        ))}
      </div>
    </div>
  );
}
