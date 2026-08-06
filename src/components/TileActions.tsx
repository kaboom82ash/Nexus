import { createContext, useContext, useEffect } from 'react'

/** An action a widget contributes to its tile's bottom control bar. */
export interface TileAction {
  key: string
  icon: string
  title: string
  onClick: () => void
}

/** The Tile provides a setter; widgets register their actions through it. */
export const TileActionsContext = createContext<(actions: TileAction[]) => void>(
  () => {},
)

/**
 * Register bottom-bar actions for the enclosing tile. Pass `deps` so the
 * registration (and its captured onClick closures) refreshes when needed.
 */
export function useTileActions(actions: TileAction[], deps: unknown[]): void {
  const register = useContext(TileActionsContext)
  useEffect(() => {
    register(actions)
    return () => register([])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
