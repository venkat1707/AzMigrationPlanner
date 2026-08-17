import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Download, FileText, Loader2, TriangleAlert, X } from 'lucide-react'
import { apiFetch } from './auth-client'

type DesignQuestion = {
  id: string
  prompt: string
  kind: 'text' | 'multiline' | 'single-choice' | 'multi-choice' | 'boolean'
  options: string[]
  required: boolean
}

type NeedsInput = { status: 'needs-input'; conversationId: string | null; message: string | null; questions: DesignQuestion[] }
type Completed = { status: 'completed'; fileName: string; contentType: string; contentBase64: string }
type DesignResponse = NeedsInput | Completed | { error?: string }

type Phase = 'working' | 'questions' | 'ready' | 'saving' | 'done' | 'error'

type SaveFilePicker = (options?: {
  suggestedName?: string
  types?: Array<{ description?: string; accept: Record<string, string[]> }>
}) => Promise<{ createWritable: () => Promise<{ write: (data: BufferSource | Blob) => Promise<void>; truncate: (size: number) => Promise<void>; close: () => Promise<void> }> }>

function decodeDocument(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    throw new Error('The generated file is not a valid modern Word document. Generate it again before saving.')
  }
  return bytes
}

async function saveDocument(file: Completed): Promise<'saved' | 'downloaded'> {
  const bytes = decodeDocument(file.contentBase64)
  const blob = new Blob([bytes], { type: file.contentType || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
  const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker
  if (picker) {
    const handle = await picker({
      suggestedName: file.fileName,
      types: [{ description: 'Word document', accept: { 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'] } }],
    })
    const writable = await handle.createWritable()
    await writable.truncate(0)
    await writable.write(bytes)
    await writable.truncate(bytes.byteLength)
    await writable.close()
    return 'saved'
  }
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = file.fileName
  link.click()
  URL.revokeObjectURL(url)
  return 'downloaded'
}

export default function DesignDocumentDialog({ application, environment, documentTitle = 'High-level design document', requestUrl = '/api/application-map/design-document', requestBody = {}, onClose }: {
  application?: string
  environment?: string
  documentTitle?: string
  requestUrl?: string
  requestBody?: Record<string, unknown>
  onClose: () => void
}) {
  const [phase, setPhase] = useState<Phase>('working')
  const [statusText, setStatusText] = useState(`Contacting the Foundry agent to generate the ${documentTitle.toLowerCase()}…`)
  const [error, setError] = useState('')
  const [questions, setQuestions] = useState<DesignQuestion[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [multi, setMulti] = useState<Record<string, Set<string>>>({})
  const [savedName, setSavedName] = useState('')
  const [saveMode, setSaveMode] = useState<'saved' | 'downloaded'>('saved')
  const [readyFile, setReadyFile] = useState<Completed | null>(null)
  const conversationId = useRef<string | null>(null)

  const send = async (payloadAnswers: Array<{ id: string; response: string }>) => {
    setPhase('working')
    setError('')
    setStatusText(payloadAnswers.length ? 'Sending your answers to the Foundry agent…' : `Contacting the Foundry agent to generate the ${documentTitle.toLowerCase()}…`)
    try {
      const response = await apiFetch(requestUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ application, environment, ...requestBody, conversationId: conversationId.current, answers: payloadAnswers }),
      })
      const data = await response.json() as DesignResponse
      if (!response.ok) throw new Error(('error' in data && data.error) || 'The design document request failed.')
      if ('status' in data && data.status === 'needs-input') {
        conversationId.current = data.conversationId ?? conversationId.current
        setMessage(data.message)
        setQuestions(data.questions)
        setAnswers({})
        setMulti({})
        setPhase('questions')
        return
      }
      if ('status' in data && data.status === 'completed') {
        // The browser only allows the save picker during a user gesture, so wait for a click.
        setReadyFile(data)
        setPhase('ready')
        return
      }
      throw new Error('The agent response could not be understood.')
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') {
        setError('Saving was cancelled. You can try generating the document again.')
      } else {
        setError(reason instanceof Error ? reason.message : 'The design document could not be generated.')
      }
      setPhase('error')
    }
  }

  useEffect(() => {
    void send([])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const submitAnswers = () => {
    const missing = questions.find((question) => {
      if (!question.required) return false
      if (question.kind === 'multi-choice') return (multi[question.id]?.size ?? 0) === 0
      return !(answers[question.id] ?? '').trim()
    })
    if (missing) {
      setError('Please answer all required questions before continuing.')
      return
    }
    const payload = questions.map((question) => ({
      id: question.id,
      response: question.kind === 'multi-choice' ? [...(multi[question.id] ?? [])].join(', ') : (answers[question.id] ?? '').trim(),
    }))
    void send(payload)
  }

  const handleSave = async () => {
    if (!readyFile) return
    setError('')
    setPhase('saving')
    setStatusText('Choose where to save the Word document…')
    try {
      const outcome = await saveDocument(readyFile)
      setSavedName(readyFile.fileName)
      setSaveMode(outcome)
      setPhase('done')
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') {
        setError('Saving was cancelled. Click Save document to choose a location.')
      } else {
        setError(reason instanceof Error ? reason.message : 'The document could not be saved.')
      }
      setPhase('ready')
    }
  }

  const toggleMulti = (questionId: string, option: string) => {
    setMulti((current) => {
      const next = new Set(current[questionId] ?? [])
      if (next.has(option)) next.delete(option)
      else next.add(option)
      return { ...current, [questionId]: next }
    })
  }

  return <div className="design-dialog-overlay" role="dialog" aria-modal="true" aria-label={`Create ${documentTitle}`}>
    <div className="design-dialog">
      <header className="design-dialog-head">
        <div><span className="design-dialog-icon"><FileText size={18} /></span><div><strong>{documentTitle}</strong><small>{application && environment ? `${application} · ${environment} · hosted on Azure` : 'Generated from the current migration plan'}</small></div></div>
        <button type="button" className="design-dialog-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </header>

      <div className="design-dialog-body">
        {phase === 'working' || phase === 'saving'
          ? <div className="design-dialog-status"><Loader2 className="spin" size={26} /><p>{statusText}</p></div>
          : null}

        {phase === 'questions'
          ? <form className="design-dialog-questions" onSubmit={(event) => { event.preventDefault(); submitAnswers() }}>
            <p className="design-dialog-intro">{message ?? 'The design agent needs a few details before it can finalize the document.'}</p>
            {questions.map((question) => <fieldset key={question.id} className="design-question">
              <legend>{question.prompt}{question.required ? <span className="design-required"> *</span> : null}</legend>
              {question.kind === 'multiline'
                ? <textarea rows={3} value={answers[question.id] ?? ''} onChange={(event) => setAnswers({ ...answers, [question.id]: event.target.value })} />
                : question.kind === 'single-choice'
                  ? <select value={answers[question.id] ?? ''} onChange={(event) => setAnswers({ ...answers, [question.id]: event.target.value })}>
                    <option value="">Select an option</option>
                    {question.options.map((option) => <option key={option} value={option}>{option}</option>)}
                  </select>
                  : question.kind === 'boolean'
                    ? <div className="design-choice-row">
                      {['Yes', 'No'].map((option) => <label key={option} className="design-choice"><input type="radio" name={question.id} checked={answers[question.id] === option} onChange={() => setAnswers({ ...answers, [question.id]: option })} /> {option}</label>)}
                    </div>
                    : question.kind === 'multi-choice'
                      ? <div className="design-choice-grid">
                        {question.options.map((option) => <label key={option} className="design-choice"><input type="checkbox" checked={multi[question.id]?.has(option) ?? false} onChange={() => toggleMulti(question.id, option)} /> {option}</label>)}
                      </div>
                      : <input type="text" value={answers[question.id] ?? ''} onChange={(event) => setAnswers({ ...answers, [question.id]: event.target.value })} />}
            </fieldset>)}
            {error ? <p className="design-dialog-error">{error}</p> : null}
            <div className="design-dialog-actions">
              <button type="button" className="ghost" onClick={onClose}>Cancel</button>
              <button type="submit"><Download size={15} /> Submit answers</button>
            </div>
          </form>
          : null}

        {phase === 'ready'
          ? <div className="design-dialog-status success">
            <CheckCircle2 size={30} />
            <p>The {documentTitle.toLowerCase()} is ready.</p>
            <small>{readyFile?.fileName}</small>
            {error ? <p className="design-dialog-error">{error}</p> : null}
            <div className="design-dialog-actions">
              <button type="button" className="ghost" onClick={onClose}>Cancel</button>
              <button type="button" onClick={() => void handleSave()}><Download size={15} /> Save document</button>
            </div>
          </div>
          : null}

        {phase === 'done'
          ? <div className="design-dialog-status success">
            <CheckCircle2 size={30} />
            <p>{saveMode === 'saved' ? `The ${documentTitle.toLowerCase()} was saved.` : `The ${documentTitle.toLowerCase()} was downloaded.`}</p>
            <small>{savedName}</small>
            <div className="design-dialog-actions"><button type="button" onClick={onClose}>Done</button></div>
          </div>
          : null}

        {phase === 'error'
          ? <div className="design-dialog-status error">
            <TriangleAlert size={28} />
            <p>{error}</p>
            <div className="design-dialog-actions">
              <button type="button" className="ghost" onClick={onClose}>Close</button>
              <button type="button" onClick={() => void send([])}>Try again</button>
            </div>
          </div>
          : null}
      </div>
    </div>
  </div>
}
