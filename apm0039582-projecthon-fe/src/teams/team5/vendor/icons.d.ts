import type { ForwardRefExoticComponent, RefAttributes, SVGProps } from 'react';

type SVGAttributes = Partial<SVGProps<SVGSVGElement>>;
type ElementAttributes = RefAttributes<SVGSVGElement> & SVGAttributes;
interface LucideProps extends ElementAttributes {
  size?: string | number;
  absoluteStrokeWidth?: boolean;
  nonScalingStroke?: boolean;
}
type LucideIcon = ForwardRefExoticComponent<Omit<LucideProps, 'ref'> & RefAttributes<SVGSVGElement>>;

export declare const ArrowLeft: LucideIcon;
export declare const ArrowRight: LucideIcon;
export declare const Clock3: LucideIcon;
export declare const DoorOpen: LucideIcon;
export declare const LoaderCircle: LucideIcon;
export declare const LockKeyhole: LucideIcon;
export declare const LogIn: LucideIcon;
export declare const LogOut: LucideIcon;
export declare const Play: LucideIcon;
export declare const RotateCcw: LucideIcon;
export declare const UserPlus: LucideIcon;
export declare const X: LucideIcon;