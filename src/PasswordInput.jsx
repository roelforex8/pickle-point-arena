import { useEffect, useId, useRef, useState } from 'react';

import { passwordInputType, passwordToggleLabel } from './passwordVisibility';

export default function PasswordInput({ id, value, ...inputProps }) {
  const generatedId = useId();
  const inputId = id || `password-${generatedId.replaceAll(':', '')}`;
  const inputRef = useRef(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!value) setVisible(false);
  }, [value]);

  useEffect(() => {
    const form = inputRef.current?.form;
    if (!form) return undefined;
    const hidePassword = () => setVisible(false);
    form.addEventListener('reset', hidePassword);
    return () => form.removeEventListener('reset', hidePassword);
  }, []);

  const label = passwordToggleLabel(visible);
  return <span className="password-visibility-field">
    <input {...inputProps} id={inputId} ref={inputRef} value={value} type={passwordInputType(visible)} />
    <button
      className="password-visibility-toggle"
      type="button"
      aria-label={label}
      aria-pressed={visible}
      aria-controls={inputId}
      title={label}
      onClick={(event) => {
        event.preventDefault();
        setVisible((current) => !current);
      }}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
        <circle cx="12" cy="12" r="2.75" />
        {!visible && <path className="password-eye-slash" d="m4 4 16 16" />}
      </svg>
    </button>
  </span>;
}
