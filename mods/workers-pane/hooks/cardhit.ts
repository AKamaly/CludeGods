// A clear layer over a worker card that isn't selected: a press anywhere on the card posts
// its key, and the pane selects it (`ui.message` in register.tsx). The selected card has no
// layer, so its buttons and fields take presses as usual.
import type { ClientModule } from 'claude-code'

const CardHit: ClientModule<{ k: string }> = (props, surface) => {
  surface.onPointer(e => {
    if (e.type === 'down') surface.post({ select: props.k })
  })
  return surface.elements.Box({ width: '100%', height: '100%' })
}

export default CardHit
