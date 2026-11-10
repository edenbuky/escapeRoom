import type { FormEvent, ReactNode } from 'react';
import './device-screen.css';

/** Places a box in percent of its parent; the room scene and the device screens use the same design numbers. */
export function percentBox(position: { left: number; top: number; width: number; height?: number }) {
  return {
    left: `${position.left}%`, top: `${position.top}%`, width: `${position.width}%`,
    ...(position.height === undefined ? {} : { height: `${position.height}%` }),
  };
}

/**
 * A device picture with its inputs and actions laid over it (use `.screen-input` / `.screen-action` with `percentBox`).
 * With `onSubmit` it is the design's `form.interactive-screen`, so Enter or a submit button on the picture sends it.
 */
export function DeviceScreen({ image, label, className, onSubmit, children }: {
  image: string; label: string; className?: string;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void; children: ReactNode;
}) {
  const classes = className ? `interactive-screen ${className}` : 'interactive-screen';
  const picture = <img src={image} alt="" draggable={false} />;
  return onSubmit
    ? <form className={classes} aria-label={label} onSubmit={onSubmit}>{picture}{children}</form>
    : <div className={classes} role="group" aria-label={label}>{picture}{children}</div>;
}
