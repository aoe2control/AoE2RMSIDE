import type { ContentPackDescriptor, RmsConstantNames } from '../shared/api';

type ConstantNamesField = (contentPack: ContentPackDescriptor) => {
  constantNames?: RmsConstantNames;
};

let provider: ConstantNamesField = () => ({});

export function provideConstantNames(field: ConstantNamesField): void {
  provider = field;
}

export function constantNamesFor(contentPack: ContentPackDescriptor): {
  constantNames?: RmsConstantNames;
} {
  return provider(contentPack);
}
