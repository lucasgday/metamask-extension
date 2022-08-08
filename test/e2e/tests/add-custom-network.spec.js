const { strict: assert } = require('assert');
const { convertToHexValue, withFixtures } = require('../helpers');

describe('Custom network', function () {
  const ganacheOptions = {
    accounts: [
      {
        secretKey:
          '0x7C9529A67102755B7E6102D6D950AC5D5863C98713805CEC576B945B15B71EAC',
        balance: convertToHexValue(25000000000000000000),
      },
    ],
  };
  it('adds custom network and switch to network', async function () {
    await withFixtures(
      {
        fixtures: 'imported-account',
        ganacheOptions,
        title: this.test.title,
      },
      async ({ driver }) => {
        await driver.navigate();
        await driver.fill('#password', 'correct horse battery staple');
        await driver.press('#password', driver.Key.ENTER);

        await driver.clickElement('.account-menu__icon');
        await driver.clickElement({ tag: 'div', text: 'Settings'});

        await driver.clickElement({ tag: 'div' , text: 'Experimental'});
        const toggleList = await driver.findElements('.toggle-button');
        toggleList[2].click();

        await driver.clickElement('.network-display');
        await driver.clickElement({ tag: 'button', text: 'Add Network'});

        const addButtons = await driver.findElements({ tag: 'button', text: 'Add'});
        addButtons[0].click();

        const title = await driver.findElement({tag: 'span', text: 'Arbitrum One'});
        assert.equal(await title.getText(), 'Arbitrum One', 'Title of popup should be selected network');

        const networkLabels = await driver.findElements('dd');
        assert.equal(networkLabels.length, 4, 'There should be 4 labels : Network Name, Network URL, Chain ID and Currency Symbol');

        assert.equal(await networkLabels[2].getText(), '42161', 'Chain ID should be 42161');
        assert.equal(await networkLabels[3].getText(), 'AETH', 'Currency symbol should be AETH');

        await driver.clickElement({ tag: 'a', text: 'View all details'});

        const networkDetailsLabels = await driver.findElements('dd'); 
        assert.equal(await networkDetailsLabels[8].getText(), 'https://explorer.arbitrum.io', 'Block Explorer URL is not correct');

        await driver.clickElement({ tag: 'button', text: 'Close'});
        await driver.clickElement({ tag: 'button', text: 'Approve'});

        await driver.clickElement({ tag: 'h6', text: 'Switch to Arbitrum One'});

        const networkName = await driver.findElement({tag: 'span', text: 'Arbitrum One'});
        assert.equal(await networkName.getText(), 'Arbitrum One', 'You have not switched to Arbitrum Network');

    },
    );
  });
});