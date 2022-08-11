/* eslint-disable jest/require-top-level-describe */
import { render } from '@testing-library/react';
import React from 'react';

import { BaseIcon } from './base-icon';

describe('BaseIcon', () => {
  it('should render correctly', () => {
    const { getByTestId, container } = render(
      <BaseIcon data-testid="base-icon" />,
    );
    expect(getByTestId('base-icon')).toBeDefined();
    expect(container.querySelector('svg')).toBeDefined();
  });
  it('should render with different size classes', () => {
    const { getByTestId } = render(
      <>
        <BaseIcon size="xs" data-testid="base-icon-xs" />
        <BaseIcon size="sm" data-testid="base-icon-sm" />
        <BaseIcon size="md" data-testid="base-icon-md" />
        <BaseIcon size="lg" data-testid="base-icon-lg" />
        <BaseIcon size="xl" data-testid="base-icon-xl" />
      </>,
    );
    expect(getByTestId('base-icon-xs')).toHaveClass('base-icon--size-xs');
    expect(getByTestId('base-icon-sm')).toHaveClass('base-icon--size-sm');
    expect(getByTestId('base-icon-md')).toHaveClass('base-icon--size-md');
    expect(getByTestId('base-icon-lg')).toHaveClass('base-icon--size-lg');
    expect(getByTestId('base-icon-xl')).toHaveClass('base-icon--size-xl');
  });
});
