import { useRef } from 'react';
import { ReceiptBrowserReminder } from './InAppBrowserHandoff';
import { formatReceiptFileSize, receiptFileAccept } from './receiptUpload';

export default function ReceiptFilePicker({ id, file, onFileChange, onFileRemove, browserInfo }) {
  const inputRef = useRef(null);

  const removeFile = () => {
    if (inputRef.current) inputRef.current.value = '';
    onFileRemove?.();
  };

  return <>
    <label className={`file-upload${file ? ' has-file' : ''}`} htmlFor={id}>
      <span className="file-upload-label">Receipt or screenshot</span>
      <input
        ref={inputRef}
        id={id}
        type="file"
        accept={receiptFileAccept}
        onClick={(event) => { event.currentTarget.value = ''; }}
        onChange={onFileChange}
        aria-describedby={`${id}-status ${id}-help`}
      />
      <span className="file-upload-surface">
        <strong>{file ? 'File selected' : 'Choose an image or PDF (20 MB max)'}</strong>
        <small id={`${id}-status`}>{file ? `${file.name} · ${formatReceiptFileSize(file.size)}` : 'No file selected'}</small>
      </span>
    </label>
    {file && <button className="file-upload-remove" type="button" onClick={removeFile}>Remove selected file</button>}
    <p className="file-upload-help" id={`${id}-help`}>Save your receipt to Photos or Files first, then choose it here.</p>
    {browserInfo?.isFacebookInAppBrowser && <ReceiptBrowserReminder platform={browserInfo.platform} />}
  </>;
}
