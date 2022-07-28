# Migration Script
This script is to help removing liquidity from marginfi accounts on legacy mainnet.

This script will close all positions, deactivate all UTP accounts, and withdraw all collateral in all marginfi accounts controlled by the wallet set in `WALLET=` in `.env`.

```sh
cp .env.example .env
yarn
yarn start
```