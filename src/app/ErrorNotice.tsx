import { Button, Label } from '@/ui/system'
import s from './ErrorNotice.module.css'

export function ErrorNotice({ message, onBack }: { message?: string; onBack: () => void }) {
  return (
    <div className={s.wrap} role="alert">
      <Label>Fault</Label>
      <p className={s.msg}>{message ?? 'Something went wrong.'}</p>
      <Button onClick={onBack}>Back</Button>
    </div>
  )
}
