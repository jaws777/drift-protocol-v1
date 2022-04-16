import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import {
	Admin,
	BN,
	MARK_PRICE_PRECISION,
	PositionDirection,
	ClearingHouseUser,
	OrderRecord,
	OrderAction,
	getMarketOrderParams,
	findComputeUnitConsumption,
} from '../sdk/src';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
} from './testHelpers';
import {
	AMM_RESERVE_PRECISION,
	AMM_TO_QUOTE_PRECISION_RATIO,
	calculateTradeAcquiredAmounts,
	FeeStructure,
	QUOTE_PRECISION,
	ZERO,
} from '../sdk';

const enumsAreEqual = (
	actual: Record<string, unknown>,
	expected: Record<string, unknown>
): boolean => {
	return JSON.stringify(actual) === JSON.stringify(expected);
};

describe('market order', () => {
	const provider = anchor.Provider.local(undefined, {
		commitment: 'confirmed',
		preflightCommitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	let clearingHouseUser: ClearingHouseUser;

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(MARK_PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);

	const marketIndex = new BN(0);
	let solUsd;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		clearingHouse = Admin.from(
			connection,
			provider.wallet,
			chProgram.programId,
			{
				commitment: 'confirmed',
			}
		);
		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribeToAll();
		solUsd = await mockOracle(1);

		const periodicity = new BN(60 * 60); // 1 HOUR

		await clearingHouse.initializeMarket(
			marketIndex,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await clearingHouse.updateMarketBaseSpread(marketIndex, 500);
		const feeStructure: FeeStructure = {
			feeNumerator: new BN(5), // 5bps
			feeDenominator: new BN(10000),
			discountTokenTiers: {
				firstTier: {
					minimumBalance: new BN(1),
					discountNumerator: new BN(1),
					discountDenominator: new BN(1),
				},
				secondTier: {
					minimumBalance: new BN(1),
					discountNumerator: new BN(1),
					discountDenominator: new BN(1),
				},
				thirdTier: {
					minimumBalance: new BN(1),
					discountNumerator: new BN(1),
					discountDenominator: new BN(1),
				},
				fourthTier: {
					minimumBalance: new BN(1),
					discountNumerator: new BN(1),
					discountDenominator: new BN(1),
				},
			},
			referralDiscount: {
				referrerRewardNumerator: new BN(1),
				referrerRewardDenominator: new BN(1),
				refereeDiscountNumerator: new BN(1),
				refereeDiscountDenominator: new BN(1),
			},
		};
		await clearingHouse.updateFee(feeStructure);

		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		clearingHouseUser = ClearingHouseUser.from(
			clearingHouse,
			provider.wallet.publicKey
		);
		await clearingHouseUser.subscribe();
	});

	beforeEach(async () => {
		await clearingHouse.moveAmmPrice(
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			ZERO
		);
		await setFeedPrice(anchor.workspace.Pyth, 1, solUsd);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
	});

	it('Long market order base', async () => {
		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);

		const tradeAcquiredAmountsNoSpread = calculateTradeAcquiredAmounts(
			direction,
			baseAssetAmount,
			clearingHouse.getMarket(0),
			'base',
			false
		);
		const tradeAcquiredAmountsWithSpread = calculateTradeAcquiredAmounts(
			direction,
			baseAssetAmount,
			clearingHouse.getMarket(0),
			'base',
			true
		);

		console.log(
			'expected quote with out spread',
			tradeAcquiredAmountsNoSpread[1]
				.abs()
				.div(AMM_TO_QUOTE_PRECISION_RATIO)
				.toString()
		);
		console.log(
			'expected quote with spread',
			tradeAcquiredAmountsWithSpread[1]
				.abs()
				.div(AMM_TO_QUOTE_PRECISION_RATIO)
				.toString()
		);
		const expectedQuoteAssetAmount = tradeAcquiredAmountsWithSpread[1]
			.div(AMM_TO_QUOTE_PRECISION_RATIO)
			.abs();

		const orderParams = getMarketOrderParams(
			marketIndex,
			direction,
			ZERO,
			baseAssetAmount,
			false
		);
		const txSig = await clearingHouse.placeAndFillOrder(orderParams);
		const computeUnits = await findComputeUnitConsumption(
			clearingHouse.program.programId,
			connection,
			txSig,
			'confirmed'
		);
		console.log('compute units', computeUnits);
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();

		console.log(
			'unrealized pnl',
			clearingHouseUser.getUnrealizedPNL().toString()
		);

		const market = clearingHouse.getMarket(marketIndex);
		const expectedFeeToMarket = new BN(1001);
		assert(market.amm.totalFee.eq(expectedFeeToMarket));

		const userPositionsAccount = clearingHouseUser.getUserPositionsAccount();
		const firstPosition = userPositionsAccount.positions[0];
		assert(firstPosition.baseAssetAmount.eq(baseAssetAmount));

		assert(firstPosition.quoteAssetAmount.eq(expectedQuoteAssetAmount));

		const tradeHistoryAccount = clearingHouse.getTradeHistoryAccount();
		const tradeHistoryRecord = tradeHistoryAccount.tradeRecords[0];

		assert.ok(tradeHistoryAccount.head.toNumber() === 1);
		assert.ok(tradeHistoryRecord.baseAssetAmount.eq(baseAssetAmount));
		assert.ok(tradeHistoryRecord.quoteAssetAmount.eq(expectedQuoteAssetAmount));

		const orderHistoryAccount = clearingHouse.getOrderHistoryAccount();
		const orderRecord: OrderRecord = orderHistoryAccount.orderRecords[1];
		const expectedRecordId = new BN(2);
		const expectedOrderId = new BN(1);
		const expectedTradeRecordId = new BN(1);
		const expectedFee = new BN(500);
		assert(orderRecord.recordId.eq(expectedRecordId));
		assert(orderRecord.ts.gt(ZERO));
		assert(orderRecord.order.orderId.eq(expectedOrderId));
		assert(orderRecord.fee.eq(expectedFee));
		assert(orderRecord.order.fee.eq(expectedFee));
		assert(enumsAreEqual(orderRecord.action, OrderAction.FILL));
		assert(
			orderRecord.user.equals(await clearingHouseUser.getUserAccountPublicKey())
		);
		assert(orderRecord.authority.equals(clearingHouseUser.authority));
		assert(orderRecord.baseAssetAmountFilled.eq(baseAssetAmount));
		assert(orderRecord.quoteAssetAmountFilled.eq(expectedQuoteAssetAmount));
		assert(orderRecord.fillerReward.eq(ZERO));
		assert(orderRecord.tradeRecordId.eq(expectedTradeRecordId));

		await clearingHouse.closePosition(marketIndex);
	});

	it('Long market order quote', async () => {
		const direction = PositionDirection.LONG;
		const quoteAssetAmount = new BN(QUOTE_PRECISION);

		const tradeAcquiredAmountsNoSpread = calculateTradeAcquiredAmounts(
			direction,
			quoteAssetAmount,
			clearingHouse.getMarket(0),
			'quote',
			false
		);
		const tradeAcquiredAmountsWithSpread = calculateTradeAcquiredAmounts(
			direction,
			quoteAssetAmount,
			clearingHouse.getMarket(0),
			'quote',
			true
		);
		console.log(
			'expected base with out spread',
			tradeAcquiredAmountsNoSpread[0].abs().toString()
		);
		console.log(
			'expected base with spread',
			tradeAcquiredAmountsWithSpread[0].abs().toString()
		);
		const expectedBaseAssetAmount = tradeAcquiredAmountsWithSpread[0].abs();

		const orderParams = getMarketOrderParams(
			marketIndex,
			direction,
			quoteAssetAmount,
			ZERO,
			false
		);
		const txSig = await clearingHouse.placeAndFillOrder(orderParams);
		const computeUnits = await findComputeUnitConsumption(
			clearingHouse.program.programId,
			connection,
			txSig,
			'confirmed'
		);
		console.log('compute units', computeUnits);
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();

		console.log(
			'unrealized pnl',
			clearingHouseUser.getUnrealizedPNL().toString()
		);

		const tradeHistoryAccount = clearingHouse.getTradeHistoryAccount();
		const tradeHistoryRecord = tradeHistoryAccount.tradeRecords[2];

		assert.ok(tradeHistoryRecord.baseAssetAmount.eq(expectedBaseAssetAmount));
		assert.ok(tradeHistoryRecord.quoteAssetAmount.eq(quoteAssetAmount));

		const orderHistoryAccount = clearingHouse.getOrderHistoryAccount();
		const orderRecord: OrderRecord = orderHistoryAccount.orderRecords[3];
		const expectedFee = new BN(500);
		assert(orderRecord.fee.eq(expectedFee));
		assert(orderRecord.order.fee.eq(expectedFee));

		await clearingHouse.closePosition(marketIndex);
	});

	it('short market order base', async () => {
		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);

		const tradeAcquiredAmountsNoSpread = calculateTradeAcquiredAmounts(
			direction,
			baseAssetAmount,
			clearingHouse.getMarket(0),
			'base',
			false
		);
		const tradeAcquiredAmountsWithSpread = calculateTradeAcquiredAmounts(
			direction,
			baseAssetAmount,
			clearingHouse.getMarket(0),
			'base',
			true
		);
		console.log(
			'expected quote with out spread',
			tradeAcquiredAmountsNoSpread[1]
				.abs()
				.div(AMM_TO_QUOTE_PRECISION_RATIO)
				.toString()
		);
		console.log(
			'expected quote with spread',
			tradeAcquiredAmountsWithSpread[1]
				.abs()
				.div(AMM_TO_QUOTE_PRECISION_RATIO)
				.toString()
		);
		const expectedQuoteAssetAmount = tradeAcquiredAmountsWithSpread[1]
			.abs()
			.div(AMM_TO_QUOTE_PRECISION_RATIO);

		const orderParams = getMarketOrderParams(
			marketIndex,
			direction,
			ZERO,
			baseAssetAmount,
			false
		);
		const txSig = await clearingHouse.placeAndFillOrder(orderParams);
		const computeUnits = await findComputeUnitConsumption(
			clearingHouse.program.programId,
			connection,
			txSig,
			'confirmed'
		);
		console.log('compute units', computeUnits);
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();

		console.log(
			'unrealized pnl',
			clearingHouseUser.getUnrealizedPNL().toString()
		);

		const tradeHistoryAccount = clearingHouse.getTradeHistoryAccount();
		const tradeHistoryRecord = tradeHistoryAccount.tradeRecords[4];

		assert.ok(tradeHistoryRecord.baseAssetAmount.eq(baseAssetAmount));
		assert.ok(tradeHistoryRecord.quoteAssetAmount.eq(expectedQuoteAssetAmount));
		const expectedFee = new BN(499);
		assert.ok(tradeHistoryRecord.fee.eq(expectedFee));

		const orderHistoryAccount = clearingHouse.getOrderHistoryAccount();
		const orderRecord: OrderRecord = orderHistoryAccount.orderRecords[5];
		assert(orderRecord.fee.eq(expectedFee));
		assert(orderRecord.order.fee.eq(expectedFee));

		await clearingHouse.closePosition(marketIndex);
		await clearingHouseUser.fetchAccounts();
		console.log(
			clearingHouseUser
				.getUserPositionsAccount()
				.positions[0].baseAssetAmount.toString()
		);
	});

	it('short market order quote', async () => {
		const direction = PositionDirection.SHORT;
		const quoteAssetAmount = new BN(QUOTE_PRECISION);

		const tradeAcquiredAmountsNoSpread = calculateTradeAcquiredAmounts(
			direction,
			quoteAssetAmount,
			clearingHouse.getMarket(0),
			'quote',
			false
		);
		const tradeAcquiredAmountsWithSpread = calculateTradeAcquiredAmounts(
			direction,
			quoteAssetAmount,
			clearingHouse.getMarket(0),
			'quote',
			true
		);
		console.log(
			'expected base with out spread',
			tradeAcquiredAmountsNoSpread[0].abs().toString()
		);
		console.log(
			'expected base with spread',
			tradeAcquiredAmountsWithSpread[0].abs().toString()
		);

		const expectedBaseAssetAmount = tradeAcquiredAmountsWithSpread[0].abs();

		const orderParams = getMarketOrderParams(
			marketIndex,
			direction,
			quoteAssetAmount,
			ZERO,
			false
		);
		const txSig = await clearingHouse.placeAndFillOrder(orderParams);
		const computeUnits = await findComputeUnitConsumption(
			clearingHouse.program.programId,
			connection,
			txSig,
			'confirmed'
		);
		console.log('compute units', computeUnits);
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();

		console.log(
			'unrealized pnl',
			clearingHouseUser.getUnrealizedPNL().toString()
		);

		const tradeHistoryAccount = clearingHouse.getTradeHistoryAccount();
		const tradeHistoryRecord = tradeHistoryAccount.tradeRecords[6];

		assert.ok(tradeHistoryRecord.baseAssetAmount.eq(expectedBaseAssetAmount));
		assert.ok(tradeHistoryRecord.quoteAssetAmount.eq(quoteAssetAmount));
		const expectedFee = new BN(500);
		assert.ok(tradeHistoryRecord.fee.eq(expectedFee));

		const orderHistoryAccount = clearingHouse.getOrderHistoryAccount();
		const orderRecord: OrderRecord = orderHistoryAccount.orderRecords[7];
		assert(orderRecord.fee.eq(expectedFee));
		assert(orderRecord.order.fee.eq(expectedFee));
	});
});
